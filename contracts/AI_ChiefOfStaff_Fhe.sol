pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AIChiefOfStaffFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatchId();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidParameter();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, bytes32 indexed dataId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 result);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;
    mapping(uint256 => bool) public batchExists;

    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(bytes32 => euint32) public encryptedData; // dataId => encrypted value
    mapping(uint256 => bytes32[]) public batchDataIds; // batchId => array of dataIds

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        cooldownSeconds = 60; // Default cooldown of 60 seconds
    }

    function addProvider(address _provider) external onlyOwner {
        if (!isProvider[_provider]) {
            isProvider[_provider] = true;
            emit ProviderAdded(_provider);
        }
    }

    function removeProvider(address _provider) external onlyOwner {
        if (isProvider[_provider]) {
            isProvider[_provider] = false;
            emit ProviderRemoved(_provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) _closeCurrentBatchInternal(); // Close previous if open
        currentBatchId++;
        batchOpen = true;
        batchExists[currentBatchId] = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        _closeCurrentBatchInternal();
    }

    function _closeCurrentBatchInternal() private {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedData(
        bytes32 _dataId,
        euint32 _encryptedValue
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        _initIfNeeded(_encryptedValue);

        encryptedData[_dataId] = _encryptedValue;
        batchDataIds[currentBatchId].push(_dataId);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, currentBatchId, _dataId);
    }

    function requestSummaryDecryption(uint256 _batchId) external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (!_isBatchValid(_batchId)) revert InvalidBatchId();

        bytes32[] memory dataIds = batchDataIds[_batchId];
        if (dataIds.length == 0) revert InvalidParameter(); // No data to summarize

        euint32 memory sum = FHE.asEuint32(0);
        for (uint i = 0; i < dataIds.length; i++) {
            euint32 memory data = encryptedData[dataIds[i]];
            _initIfNeeded(data);
            sum = sum.add(data);
        }
        _initIfNeeded(sum);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(sum);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: _batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, _batchId, stateHash);
    }

    function myCallback(
        uint256 _requestId,
        bytes memory _cleartexts,
        bytes memory _proof
    ) public {
        if (decryptionContexts[_requestId].processed) revert ReplayAttempt();
        // Security: Replay protection prevents processing the same decryption request multiple times.

        DecryptionContext memory context = decryptionContexts[_requestId];
        uint256 batchId = context.batchId;

        bytes32[] memory currentCts = new bytes32[](1);
        bytes32[] memory dataIds = batchDataIds[batchId];
        if (dataIds.length == 0) revert InvalidParameter(); // Should not happen if requestSummaryDecryption was called

        euint32 memory currentSum = FHE.asEuint32(0);
        for (uint i = 0; i < dataIds.length; i++) {
            euint32 memory data = encryptedData[dataIds[i]];
            _initIfNeeded(data);
            currentSum = currentSum.add(data);
        }
        _initIfNeeded(currentSum);
        currentCts[0] = FHE.toBytes32(currentSum);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        // Security: State hash verification ensures that the contract's state (specifically the ciphertexts being decrypted)
        // has not changed since the decryption was requested. This prevents scenarios where an attacker might alter
        // data after a request is made but before it's processed, leading to inconsistent results.
        if (currentStateHash != context.stateHash) revert StateMismatch();

        // Security: Proof verification ensures that the decryption was performed correctly by the FHEVM network
        // and that the cleartexts correspond to the ciphertexts submitted for decryption.
        FHE.checkSignatures(_requestId, _cleartexts, _proof);

        uint256 result = abi.decode(_cleartexts, (uint256));
        decryptionContexts[_requestId].processed = true;
        emit DecryptionCompleted(_requestId, batchId, result);
    }

    function _hashCiphertexts(bytes32[] memory _cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(_cts, address(this)));
    }

    function _initIfNeeded(euint32 memory _val) internal view {
        if (!_val.isInitialized()) revert NotInitialized();
    }

    function _isBatchValid(uint256 _batchId) internal view returns (bool) {
        return batchExists[_batchId];
    }
}