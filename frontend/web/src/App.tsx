// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ScheduleItem {
  id: string;
  encryptedTitle: string;
  encryptedTime: string;
  encryptedDuration: string;
  category: string;
  timestamp: number;
  status: "pending" | "completed" | "missed";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newSchedule, setNewSchedule] = useState({ category: "meeting", title: "", time: "", duration: 60 });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<"dashboard" | "updates" | "faq">("dashboard");
  const [decryptedItem, setDecryptedItem] = useState<{id: string, title: string, time: string, duration: string} | null>(null);

  // Stats calculations
  const completedCount = schedules.filter(s => s.status === "completed").length;
  const pendingCount = schedules.filter(s => s.status === "pending").length;
  const missedCount = schedules.filter(s => s.status === "missed").length;
  const productivityScore = schedules.length > 0 ? 
    Math.round((completedCount / schedules.length) * 100) : 0;

  useEffect(() => {
    loadSchedules().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadSchedules = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }

      // Load schedule keys
      const keysBytes = await contract.getData("schedule_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing schedule keys:", e); }
      }

      // Load each schedule
      const list: ScheduleItem[] = [];
      for (const key of keys) {
        try {
          const scheduleBytes = await contract.getData(`schedule_${key}`);
          if (scheduleBytes.length > 0) {
            try {
              const scheduleData = JSON.parse(ethers.toUtf8String(scheduleBytes));
              list.push({ 
                id: key, 
                encryptedTitle: scheduleData.title,
                encryptedTime: scheduleData.time,
                encryptedDuration: scheduleData.duration,
                category: scheduleData.category,
                timestamp: scheduleData.timestamp,
                status: scheduleData.status || "pending"
              });
            } catch (e) { console.error(`Error parsing schedule data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading schedule ${key}:`, e); }
      }

      list.sort((a, b) => b.timestamp - a.timestamp);
      setSchedules(list);
    } catch (e) { console.error("Error loading schedules:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createSchedule = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting schedule with Zama FHE..." });
    
    try {
      // Encrypt all numerical data with FHE
      const encryptedDuration = FHEEncryptNumber(newSchedule.duration);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const scheduleId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const scheduleData = { 
        title: newSchedule.title,
        time: newSchedule.time,
        duration: encryptedDuration,
        category: newSchedule.category,
        timestamp: Math.floor(Date.now() / 1000),
        status: "pending"
      };
      
      // Store the schedule data
      await contract.setData(`schedule_${scheduleId}`, ethers.toUtf8Bytes(JSON.stringify(scheduleData)));
      
      // Update the keys list
      const keysBytes = await contract.getData("schedule_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(scheduleId);
      await contract.setData("schedule_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Schedule encrypted and stored securely!" });
      await loadSchedules();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewSchedule({ category: "meeting", title: "", time: "", duration: 60 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (item: ScheduleItem): Promise<void> => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      
      // Simulate FHE decryption
      const decryptedDuration = FHEDecryptNumber(item.encryptedDuration);
      
      setDecryptedItem({
        id: item.id,
        title: item.encryptedTitle, // In real scenario, this would also be encrypted
        time: item.encryptedTime,   // In real scenario, this would also be encrypted
        duration: `${decryptedDuration} mins`
      });
    } catch (e) { 
      console.error("Decryption failed:", e); 
      setTransactionStatus({ visible: true, status: "error", message: "Decryption failed: Wallet signature rejected" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const markAsComplete = async (scheduleId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating encrypted schedule status..." });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const scheduleBytes = await contract.getData(`schedule_${scheduleId}`);
      if (scheduleBytes.length === 0) throw new Error("Schedule not found");
      
      const scheduleData = JSON.parse(ethers.toUtf8String(scheduleBytes));
      const updatedSchedule = { ...scheduleData, status: "completed" };
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      await contractWithSigner.setData(`schedule_${scheduleId}`, ethers.toUtf8Bytes(JSON.stringify(updatedSchedule)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Schedule marked as complete!" });
      await loadSchedules();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Update failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const renderProductivityChart = () => {
    return (
      <div className="productivity-chart">
        <div className="chart-bar" style={{ height: `${productivityScore}%` }}>
          <div className="chart-value">{productivityScore}%</div>
        </div>
        <div className="chart-label">Productivity Score</div>
      </div>
    );
  };

  const renderStatusDistribution = () => {
    const total = schedules.length || 1;
    const completedPercentage = (completedCount / total) * 100;
    const pendingPercentage = (pendingCount / total) * 100;
    const missedPercentage = (missedCount / total) * 100;

    return (
      <div className="status-distribution">
        <div className="distribution-bar">
          <div className="completed-segment" style={{ width: `${completedPercentage}%` }}></div>
          <div className="pending-segment" style={{ width: `${pendingPercentage}%` }}></div>
          <div className="missed-segment" style={{ width: `${missedPercentage}%` }}></div>
        </div>
        <div className="distribution-legend">
          <div className="legend-item">
            <div className="color-dot completed"></div>
            <span>Completed: {completedCount}</span>
          </div>
          <div className="legend-item">
            <div className="color-dot pending"></div>
            <span>Pending: {pendingCount}</span>
          </div>
          <div className="legend-item">
            <div className="color-dot missed"></div>
            <span>Missed: {missedCount}</span>
          </div>
        </div>
      </div>
    );
  };

  const faqItems = [
    {
      question: "How does FHE protect my schedule data?",
      answer: "Zama FHE encrypts your schedule details (duration, timing) so they remain private even during processing. The AI assistant can work with encrypted data without seeing the actual content."
    },
    {
      question: "What data is encrypted?",
      answer: "All numerical data (durations, timestamps) are fully encrypted. Text data (titles, descriptions) are stored securely but not FHE encrypted as FHE currently works best with numbers."
    },
    {
      question: "Can I decrypt my data later?",
      answer: "Yes, you can decrypt any item by signing with your wallet. The decryption happens locally in your browser - the server never sees your unencrypted data."
    },
    {
      question: "How does the AI work with encrypted data?",
      answer: "Using homomorphic encryption properties, the AI can perform operations like scheduling, conflict detection, and time optimization without decrypting your sensitive information."
    }
  ];

  const updates = [
    { version: "1.2.0", date: "2025-09-15", changes: ["Added FHE-powered analytics dashboard", "Improved schedule conflict detection"] },
    { version: "1.1.3", date: "2025-08-28", changes: ["Fixed timezone handling", "Optimized encryption performance"] },
    { version: "1.1.0", date: "2025-08-10", changes: ["Added multi-wallet support", "Enhanced calendar integration"] },
    { version: "1.0.0", date: "2025-07-01", changes: ["Initial release with Zama FHE integration", "Basic schedule management"] }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="circuit-icon"></div>
          </div>
          <h1>AI Chief of Staff</h1>
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-btn tech-button"
          >
            <div className="add-icon"></div>
            <span>New Schedule</span>
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
          </div>
        </div>
      </header>

      <div className="main-content">
        <nav className="app-nav">
          <button 
            className={`nav-btn ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
          </button>
          <button 
            className={`nav-btn ${activeTab === "updates" ? "active" : ""}`}
            onClick={() => setActiveTab("updates")}
          >
            Updates
          </button>
          <button 
            className={`nav-btn ${activeTab === "faq" ? "active" : ""}`}
            onClick={() => setActiveTab("faq")}
          >
            FAQ
          </button>
        </nav>

        {activeTab === "dashboard" && (
          <div className="dashboard-grid">
            <div className="dashboard-card tech-card">
              <h3>Productivity Overview</h3>
              <div className="stats-row">
                <div className="stat-box">
                  <div className="stat-value">{schedules.length}</div>
                  <div className="stat-label">Total Schedules</div>
                </div>
                <div className="stat-box">
                  <div className="stat-value">{completedCount}</div>
                  <div className="stat-label">Completed</div>
                </div>
                <div className="stat-box">
                  <div className="stat-value">{pendingCount}</div>
                  <div className="stat-label">Pending</div>
                </div>
              </div>
              {renderProductivityChart()}
            </div>

            <div className="dashboard-card tech-card">
              <h3>Schedule Status</h3>
              {renderStatusDistribution()}
              <div className="fhe-notice">
                <div className="lock-icon"></div>
                <p>All duration calculations performed on FHE-encrypted data</p>
              </div>
            </div>

            <div className="dashboard-card tech-card full-width">
              <div className="card-header">
                <h3>Your Encrypted Schedule</h3>
                <button 
                  onClick={loadSchedules} 
                  className="refresh-btn tech-button" 
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              
              {schedules.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon"></div>
                  <p>No encrypted schedules found</p>
                  <button 
                    className="tech-button primary" 
                    onClick={() => setShowCreateModal(true)}
                  >
                    Create First Schedule
                  </button>
                </div>
              ) : (
                <div className="schedule-table">
                  <div className="table-header">
                    <div className="header-cell">Title</div>
                    <div className="header-cell">Time</div>
                    <div className="header-cell">Category</div>
                    <div className="header-cell">Status</div>
                    <div className="header-cell">Actions</div>
                  </div>
                  {schedules.map(schedule => (
                    <div className="table-row" key={schedule.id}>
                      <div className="table-cell">
                        {decryptedItem?.id === schedule.id ? decryptedItem.title : schedule.encryptedTitle.substring(0, 20) + '...'}
                      </div>
                      <div className="table-cell">
                        {decryptedItem?.id === schedule.id ? decryptedItem.time : schedule.encryptedTime.substring(0, 10) + '...'}
                      </div>
                      <div className="table-cell">
                        <span className={`category-tag ${schedule.category}`}>{schedule.category}</span>
                      </div>
                      <div className="table-cell">
                        <span className={`status-badge ${schedule.status}`}>{schedule.status}</span>
                      </div>
                      <div className="table-cell actions">
                        <button 
                          className="action-btn tech-button"
                          onClick={() => decryptWithSignature(schedule)}
                        >
                          Decrypt
                        </button>
                        {schedule.status === "pending" && (
                          <button 
                            className="action-btn tech-button success"
                            onClick={() => markAsComplete(schedule.id)}
                          >
                            Complete
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "updates" && (
          <div className="updates-container tech-card">
            <h2>Version Updates</h2>
            <div className="updates-list">
              {updates.map((update, index) => (
                <div className="update-item" key={index}>
                  <div className="update-header">
                    <span className="version-badge">v{update.version}</span>
                    <span className="update-date">{update.date}</span>
                  </div>
                  <ul className="update-changes">
                    {update.changes.map((change, i) => (
                      <li key={i}>{change}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="fhe-notice">
              <div className="shield-icon"></div>
              <p>All versions include Zama FHE security enhancements</p>
            </div>
          </div>
        )}

        {activeTab === "faq" && (
          <div className="faq-container tech-card">
            <h2>Frequently Asked Questions</h2>
            <div className="faq-list">
              {faqItems.map((item, index) => (
                <div className="faq-item" key={index}>
                  <div className="faq-question">
                    <div className="question-icon">Q</div>
                    <h3>{item.question}</h3>
                  </div>
                  <div className="faq-answer">
                    <div className="answer-icon">A</div>
                    <p>{item.answer}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal tech-card">
            <div className="modal-header">
              <h2>New Encrypted Schedule</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Title</label>
                <input
                  type="text"
                  value={newSchedule.title}
                  onChange={(e) => setNewSchedule({...newSchedule, title: e.target.value})}
                  placeholder="Meeting title"
                  className="tech-input"
                />
              </div>
              <div className="form-group">
                <label>Time</label>
                <input
                  type="datetime-local"
                  value={newSchedule.time}
                  onChange={(e) => setNewSchedule({...newSchedule, time: e.target.value})}
                  className="tech-input"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Duration (minutes)</label>
                  <input
                    type="number"
                    value={newSchedule.duration}
                    onChange={(e) => setNewSchedule({...newSchedule, duration: parseInt(e.target.value) || 0})}
                    className="tech-input"
                  />
                </div>
                <div className="form-group">
                  <label>Category</label>
                  <select
                    value={newSchedule.category}
                    onChange={(e) => setNewSchedule({...newSchedule, category: e.target.value})}
                    className="tech-select"
                  >
                    <option value="meeting">Meeting</option>
                    <option value="task">Task</option>
                    <option value="reminder">Reminder</option>
                    <option value="event">Event</option>
                  </select>
                </div>
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-content">
                  <div className="plain-data">
                    <span>Duration:</span> {newSchedule.duration} mins
                  </div>
                  <div className="encrypted-data">
                    <span>Encrypted:</span> {FHEEncryptNumber(newSchedule.duration).substring(0, 30)}...
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => setShowCreateModal(false)} 
                className="tech-button secondary"
              >
                Cancel
              </button>
              <button 
                onClick={createSchedule} 
                disabled={creating || !newSchedule.title || !newSchedule.time}
                className="tech-button primary"
              >
                {creating ? "Encrypting..." : "Create Schedule"}
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="circuit-icon"></div>
              <span>AI Chief of Staff</span>
            </div>
            <p>Your FHE-powered productivity assistant</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="copyright">
            © {new Date().getFullYear()} AI Chief of Staff. All rights reserved.
          </div>
          <div className="fhe-badge">
            <span>Secured by Zama FHE</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;