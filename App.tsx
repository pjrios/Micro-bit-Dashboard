import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, BarChart, Bar, ScatterChart, Scatter, Cell } from 'recharts';
import { Activity, Bluetooth, Download, Play, Save, Settings, Terminal, Trash2, Volume2, Plus, Upload, WifiOff, Send } from 'lucide-react';

import { btService } from './services/bluetoothService';
import { getSounds, saveSound, deleteSound } from './services/dbService';
import { Button, Card, Input, Select } from './components/Controls';
import { UART_CONFIG, BluetoothConfig, DataPoint, Rule, SoundAsset, RuleOperator } from './types';

// Constants
const MAX_HISTORY = 10000;
const CHART_HISTORY_LIMIT = 50; // Points to show on chart
const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

const App: React.FC = () => {
  // --- State ---
  // Connection
  const [status, setStatus] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'>('DISCONNECTED');
  const [config, setConfig] = useState<BluetoothConfig>(UART_CONFIG);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Data
  const [history, setHistory] = useState<DataPoint[]>([]);
  const [latest, setLatest] = useState<DataPoint | null>(null);
  const [availableKeys, setAvailableKeys] = useState<string[]>([]);
  const [parseErrors, setParseErrors] = useState(0);
  const [diagnosticServices, setDiagnosticServices] = useState<string[] | null>(null);
  const [diagnosticUartChars, setDiagnosticUartChars] = useState<string[] | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  
  // Buffering
  const bufferRef = useRef<string>('');
  
  // Visualizations
  const [selectedChartField, setSelectedChartField] = useState<string>('');
  const [chartType, setChartType] = useState<'line' | 'bar' | 'scatter'>('line');
  const [chartWindow, setChartWindow] = useState<number>(30); // seconds

  // Rules & Audio
  const [sounds, setSounds] = useState<SoundAsset[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [audioEnabled, setAudioEnabled] = useState(false);
  
  // Logging
  const [isRecording, setIsRecording] = useState(false);
  const sessionLog = useRef<DataPoint[]>([]);

  // Commands
  const [cmdInput, setCmdInput] = useState('');

  // --- Audio Engine ---
  const audioContextRef = useRef<AudioContext | null>(null);
  
  const initAudio = () => {
    if (!audioContextRef.current) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioCtx();
    }
    if (audioContextRef.current?.state === 'suspended') {
      audioContextRef.current.resume();
    }
    setAudioEnabled(true);
  };

  const playSound = async (soundId: string, volume: number = 1) => {
    if (!audioContextRef.current) return;
    const sound = sounds.find(s => s.id === soundId);
    if (!sound) return;

    try {
      const response = await fetch(sound.url!);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
      
      const source = audioContextRef.current.createBufferSource();
      const gainNode = audioContextRef.current.createGain();
      
      source.buffer = audioBuffer;
      gainNode.gain.value = volume;
      
      source.connect(gainNode);
      gainNode.connect(audioContextRef.current.destination);
      source.start(0);
    } catch (e) {
      console.error("Audio playback error", e);
    }
  };

  // --- Bluetooth Logic ---
  
  const processLine = useCallback((line: string) => {
    let point: DataPoint | null = null;
    const now = Date.now();

    // Try JSON
    if (line.startsWith('{')) {
      try {
        const json = JSON.parse(line);
        // Ensure values are numbers
        const safeData: any = { timestamp: now };
        for (const key in json) {
          const val = Number(json[key]);
          if (!isNaN(val)) safeData[key] = val;
        }
        point = safeData;
      } catch (e) {
        // Ignore JSON error, maybe CSV
      }
    }

    // Try CSV
    if (!point && line.includes(',')) {
        try {
            // Heuristic: If we have previous keys, assume value order matches keys.
            // Or look for "key,key,value,value" pattern? 
            // The prompt says: "t,temp,light... then values". 
            // We'll implement a simple Key:Value pair detector or Headers first approach.
            // For robustness, let's assume if it looks like key,value pairs: "temp,24,light,100"
            const parts = line.split(',');
            if (parts.length >= 2 && parts.length % 2 === 0) {
                 const safeData: any = { timestamp: now };
                 for (let i = 0; i < parts.length; i += 2) {
                     const key = parts[i].trim();
                     const val = Number(parts[i+1]);
                     if (!isNaN(val) && key) safeData[key] = val;
                 }
                 if (Object.keys(safeData).length > 1) point = safeData;
            }
        } catch (e) {}
    }

    if (point) {
      // Update Data State
      setLatest(point);
      
      // Update History (Rolling buffer)
      setHistory(prev => {
        const next = [...prev, point!];
        if (next.length > MAX_HISTORY) return next.slice(next.length - MAX_HISTORY);
        return next;
      });

      // Update Keys (if new ones appear)
      const keys = Object.keys(point).filter(k => k !== 'timestamp');
      setAvailableKeys(prev => {
        const newKeys = keys.filter(k => !prev.includes(k));
        if (newKeys.length > 0) {
            // Auto select first field for chart if none selected
            if (!selectedChartField) setSelectedChartField(newKeys[0]);
            return [...prev, ...newKeys];
        }
        return prev;
      });

      // Logging
      if (isRecording) {
        sessionLog.current.push(point);
      }

      // Check Rules
      checkRules(point);

    } else {
      if (line.trim().length > 0) setParseErrors(prev => prev + 1);
    }
  }, [isRecording, selectedChartField]); // rules are handled via ref or inside checkRules if state dependencies managed

  // We use a ref for rules to avoid stale closures in the high-frequency processLine callback
  const rulesRef = useRef(rules);
  useEffect(() => { rulesRef.current = rules; }, [rules]);

  const checkRules = (data: DataPoint) => {
    const now = Date.now();
    const updatedRules = rulesRef.current.map(rule => {
      if (!rule.active) return rule;
      if (now - rule.lastTriggered < rule.cooldown) return rule;

      const val = data[rule.field];
      if (val === undefined) return rule;

      // TODO: Implement smoothing (moving average) here if needed using history
      // For now, instantaneous value
      
      let triggered = false;
      switch (rule.operator) {
        case '>': triggered = val > rule.threshold1; break;
        case '<': triggered = val < rule.threshold1; break;
        case '>=': triggered = val >= rule.threshold1; break;
        case '<=': triggered = val <= rule.threshold1; break;
        case '==': triggered = val === rule.threshold1; break;
        case '!=': triggered = val !== rule.threshold1; break;
        case 'between': triggered = val >= rule.threshold1 && val <= (rule.threshold2 || 0); break;
      }

      if (triggered) {
        playSound(rule.soundId);
        return { ...rule, lastTriggered: now };
      }
      return rule;
    });

    // Only update state if timestamps changed to avoid render loop
    // Actually, we shouldn't update react state inside the data loop frequently.
    // We will just mutate a local tracker or use a Ref for cooldowns in a real high-perf app.
    // For this dashboard, we'll optimistically update the ref's lastTriggered to block subsequent triggers immediately
    // and sync state less often.
    
    // Quick Fix: Mutate the ref directly for immediate cooldown logic within this tick
    updatedRules.forEach((r, i) => {
        if (r.lastTriggered !== rulesRef.current[i].lastTriggered) {
             rulesRef.current[i] = r;
        }
    });
  };

  const handleDataIncoming = (text: string) => {
    bufferRef.current += text;
    let newlineIndex: number;
    while ((newlineIndex = bufferRef.current.indexOf('\n')) !== -1) {
      const line = bufferRef.current.substring(0, newlineIndex).trim();
      if (line) processLine(line);
      bufferRef.current = bufferRef.current.substring(newlineIndex + 1);
    }
  };

  const handleConnect = async () => {
    setStatus('CONNECTING');
    setErrorMessage(null);
    try {
      await btService.connect(config, handleDataIncoming);
      setStatus('CONNECTED');
      btService.setDisconnectCallback(() => setStatus('DISCONNECTED'));
      initAudio(); // Try to init audio on user gesture
    } catch (e: any) {
      setStatus('DISCONNECTED');
      // If the user cancelled, we don't necessarily need a loud error message, 
      // but we should inform them why it stopped.
      if (e.name === 'NotFoundError' || (e.message && e.message.toLowerCase().includes('cancel'))) {
        setErrorMessage('Connection cancelled by user.');
      } else {
        setErrorMessage(e.message || 'Connection failed');
      }
    }
  };

  const handleDisconnect = () => {
    btService.disconnect();
    setStatus('DISCONNECTED');
  };

  const sendCommand = async () => {
    if (!cmdInput) return;
    try {
      await btService.send(cmdInput);
      setCmdInput('');
    } catch (e) {
      console.error(e);
    }
  };

  const runDiagnostics = async () => {
    setDiagnosticError(null);
    setDiagnosticServices(null);
    setDiagnosticUartChars(null);
    try {
      const result = await btService.diagnoseServices();
      setDiagnosticServices(result.services);
      setDiagnosticUartChars(result.uartCharacteristics);
    } catch (e: any) {
      setDiagnosticError(e.message || 'Diagnostics failed');
    }
  };

  // --- Effects ---
  useEffect(() => {
    // Load sounds
    getSounds().then(setSounds).catch(console.error);
    
    // Load persisted rules (mock)
    const savedRules = localStorage.getItem('microbit_rules');
    if (savedRules) {
        try { setRules(JSON.parse(savedRules)); } catch(e){}
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('microbit_rules', JSON.stringify(rules));
  }, [rules]);


  // --- Helper Functions ---
  const handleUploadSound = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const newSound: SoundAsset = {
        id: crypto.randomUUID(),
        name: file.name,
        blob: file,
        url: URL.createObjectURL(file)
      };
      await saveSound(newSound);
      setSounds(prev => [...prev, newSound]);
    }
  };

  const addRule = () => {
    if (!availableKeys.length) return;
    const newRule: Rule = {
      id: crypto.randomUUID(),
      name: 'New Rule',
      field: availableKeys[0],
      operator: '>',
      threshold1: 0,
      soundId: sounds[0]?.id || '',
      cooldown: 1000,
      lastTriggered: 0,
      active: true,
      smoothingSamples: 1
    };
    setRules([...rules, newRule]);
  };

  const deleteRule = (id: string) => {
    setRules(rules.filter(r => r.id !== id));
  };

  const updateRule = (id: string, updates: Partial<Rule>) => {
    setRules(rules.map(r => r.id === id ? { ...r, ...updates } : r));
  };

  const exportData = (format: 'csv' | 'json') => {
    const dataToExport = sessionLog.current.length > 0 ? sessionLog.current : history;
    if (dataToExport.length === 0) return;

    let content = '';
    let type = '';
    
    if (format === 'json') {
      content = JSON.stringify(dataToExport, null, 2);
      type = 'application/json';
    } else {
      const headers = ['timestamp', ...Object.keys(dataToExport[0]).filter(k => k !== 'timestamp')];
      content = headers.join(',') + '\n' + 
        dataToExport.map(row => headers.map(h => row[h] || '').join(',')).join('\n');
      type = 'text/csv';
    }

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `microbit-data-${Date.now()}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- Render ---

  // Filter history for Chart
  const chartData = history.filter(d => d.timestamp > Date.now() - (chartWindow * 1000));
  // Decimate for performance if too many points
  const displayChartData = chartData.length > 200 
    ? chartData.filter((_, i) => i % Math.ceil(chartData.length / 200) === 0)
    : chartData;

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="bg-dark-900 border-b border-gray-800 p-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-brand-600 p-2 rounded-lg">
            <Bluetooth className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Micro:bit<span className="text-brand-500">Dash</span></h1>
        </div>

        <div className="flex items-center gap-4">
            {status === 'CONNECTED' && (
                <div className="flex items-center gap-2 px-3 py-1 bg-green-900/30 text-green-400 rounded-full text-xs font-medium border border-green-800">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    Live
                </div>
            )}
            
            {!audioEnabled && (
                <Button variant="secondary" onClick={initAudio} className="flex items-center gap-2 text-sm">
                    <Volume2 size={16} /> Enable Audio
                </Button>
            )}

            {status === 'DISCONNECTED' ? (
                <div className="flex items-center gap-2">
                  <Button onClick={handleConnect} className="flex items-center gap-2">
                    <Bluetooth size={18} /> Connect
                  </Button>
                  <Button variant="secondary" onClick={runDiagnostics} className="flex items-center gap-2 text-sm">
                    Diagnostics
                  </Button>
                </div>
            ) : status === 'CONNECTING' ? (
                <Button disabled className="flex items-center gap-2">
                    <Bluetooth size={18} className="animate-spin" /> Connecting...
                </Button>
            ) : (
                <Button variant="danger" onClick={handleDisconnect} className="flex items-center gap-2">
                    <WifiOff size={18} /> Disconnect
                </Button>
            )}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Left Sidebar (Config & Rules) */}
        <aside className="w-80 bg-dark-900 border-r border-gray-800 overflow-y-auto p-4 flex flex-col gap-6 shrink-0">
          
          {/* Connection Config */}
          <section>
            <h3 className="text-gray-400 text-xs font-bold uppercase mb-3 flex items-center gap-2">
                <Settings size={14} /> Connection Setup
            </h3>
            <Card className="text-sm">
                <div className="flex gap-2 mb-3">
                    <button 
                        onClick={() => setConfig({...config, mode: 'UART', ...UART_CONFIG})} 
                        className={`flex-1 py-1 rounded text-xs ${config.mode === 'UART' ? 'bg-brand-600 text-white' : 'bg-gray-700 text-gray-300'}`}
                    >UART</button>
                    <button 
                         onClick={() => setConfig({...config, mode: 'CUSTOM'})} 
                         className={`flex-1 py-1 rounded text-xs ${config.mode === 'CUSTOM' ? 'bg-brand-600 text-white' : 'bg-gray-700 text-gray-300'}`}
                    >Custom</button>
                </div>
                {config.mode === 'CUSTOM' && (
                    <div className="space-y-2">
                        <Input label="Service UUID" value={config.serviceUUID} onChange={e => setConfig({...config, serviceUUID: e.target.value})} />
                        <Input label="TX UUID (Notify)" value={config.txUUID} onChange={e => setConfig({...config, txUUID: e.target.value})} />
                        <Input label="RX UUID (Write)" value={config.rxUUID} onChange={e => setConfig({...config, rxUUID: e.target.value})} />
                    </div>
                )}
            </Card>
            {errorMessage && <div className="mt-2 text-red-400 text-xs">{errorMessage}</div>}
            {diagnosticError && <div className="mt-2 text-red-400 text-xs">{diagnosticError}</div>}
            {diagnosticServices && (
                <div className="mt-2 text-gray-400 text-[11px] break-all">
                  Services: {diagnosticServices.join(', ')}
                </div>
            )}
            {diagnosticUartChars && (
                <div className="mt-2 text-gray-400 text-[11px] break-all">
                  UART Chars: {diagnosticUartChars.join(', ')}
                </div>
            )}
          </section>

          {/* Rules Engine */}
          <section className="flex-1">
             <div className="flex items-center justify-between mb-3">
                <h3 className="text-gray-400 text-xs font-bold uppercase flex items-center gap-2">
                    <Activity size={14} /> Rules
                </h3>
                <button onClick={addRule} className="p-1 hover:bg-gray-800 rounded"><Plus size={16} /></button>
             </div>
             
             <div className="space-y-3">
                {rules.length === 0 && <div className="text-gray-600 text-xs text-center py-4">No rules defined. Connect device to see fields.</div>}
                {rules.map((rule, idx) => (
                    <Card key={rule.id} className="text-xs">
                        <div className="flex justify-between items-center mb-2">
                             <input className="bg-transparent font-bold text-gray-200 w-full outline-none" value={rule.name} onChange={e => updateRule(rule.id, {name: e.target.value})} />
                             <button onClick={() => deleteRule(rule.id)} className="text-red-400 hover:text-red-300"><Trash2 size={14} /></button>
                        </div>
                        <div className="grid grid-cols-3 gap-1 mb-2">
                            <span className="col-span-1 text-gray-400 pt-2">IF</span>
                            <Select value={rule.field} onChange={e => updateRule(rule.id, {field: e.target.value})} className="col-span-2">
                                {availableKeys.map(k => <option key={k} value={k}>{k}</option>)}
                            </Select>
                        </div>
                        <div className="grid grid-cols-3 gap-1 mb-2">
                            <Select value={rule.operator} onChange={e => updateRule(rule.id, {operator: e.target.value as RuleOperator})}>
                                <option value=">">&gt;</option>
                                <option value="<">&lt;</option>
                                <option value="==">=</option>
                                <option value="!=">!=</option>
                            </Select>
                            <Input type="number" value={rule.threshold1} onChange={e => updateRule(rule.id, {threshold1: parseFloat(e.target.value)})} className="col-span-2" />
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                            <span className="col-span-1 text-gray-400 pt-2">PLAY</span>
                            <Select value={rule.soundId} onChange={e => updateRule(rule.id, {soundId: e.target.value})} className="col-span-2">
                                <option value="">(Select Sound)</option>
                                {sounds.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </Select>
                        </div>
                        <div className="mt-2 pt-2 border-t border-gray-700 flex items-center justify-between">
                             <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={rule.active} onChange={e => updateRule(rule.id, {active: e.target.checked})} />
                                <span className={rule.active ? 'text-green-400' : 'text-gray-500'}>Active</span>
                             </label>
                             <span className="text-gray-500">{rule.cooldown}ms cool</span>
                        </div>
                    </Card>
                ))}
             </div>
          </section>

          {/* Sound Library */}
          <section>
            <h3 className="text-gray-400 text-xs font-bold uppercase mb-3 flex items-center gap-2">
                <Volume2 size={14} /> Sound Library
            </h3>
            <Card className="text-xs">
                 <div className="space-y-2 mb-3 max-h-32 overflow-y-auto">
                    {sounds.map(s => (
                        <div key={s.id} className="flex justify-between items-center bg-dark-900 p-2 rounded">
                            <span className="truncate flex-1" title={s.name}>{s.name}</span>
                            <div className="flex gap-2">
                                <button onClick={() => playSound(s.id)}><Play size={12} className="text-green-400"/></button>
                                <button onClick={() => {
                                    deleteSound(s.id);
                                    setSounds(sounds.filter(x => x.id !== s.id));
                                }}><Trash2 size={12} className="text-red-400"/></button>
                            </div>
                        </div>
                    ))}
                 </div>
                 <label className="flex items-center justify-center gap-2 w-full py-2 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer transition-colors">
                    <Upload size={14} /> Upload Audio
                    <input type="file" accept="audio/*" onChange={handleUploadSound} className="hidden" />
                 </label>
            </Card>
          </section>

        </aside>

        {/* Center Dashboard */}
        <main className="flex-1 overflow-y-auto bg-dark-950 p-6">
            
            {/* Live Data Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-6">
                {availableKeys.map((key, i) => (
                    <div key={key} 
                        onClick={() => setSelectedChartField(key)}
                        className={`p-4 rounded-xl border cursor-pointer transition-all ${selectedChartField === key ? 'bg-brand-900/20 border-brand-500 ring-1 ring-brand-500' : 'bg-dark-800 border-gray-700 hover:border-gray-500'}`}
                    >
                        <div className="text-gray-400 text-xs font-bold uppercase mb-1">{key}</div>
                        <div className="text-2xl font-mono text-white tracking-tighter">
                            {latest?.[key]?.toFixed(2) ?? '--'}
                        </div>
                        {/* Mini Sparkline could go here */}
                    </div>
                ))}
            </div>

            {/* Visualization Panel */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6 h-[400px]">
                {/* Main Chart */}
                <Card className="lg:col-span-2 flex flex-col h-full" title="Real-time Analysis">
                    <div className="flex justify-between items-center mb-4 px-2">
                         <div className="flex gap-2 text-xs">
                             <span className="text-gray-400 flex items-center">Window:</span>
                             {[10, 30, 60, 120].map(w => (
                                 <button key={w} onClick={() => setChartWindow(w)} className={`px-2 py-0.5 rounded ${chartWindow === w ? 'bg-brand-600 text-white' : 'bg-gray-700'}`}>
                                     {w}s
                                 </button>
                             ))}
                         </div>
                         <div className="flex gap-2">
                            <button onClick={() => setChartType('line')} className={`p-1 rounded ${chartType === 'line' ? 'text-brand-400' : 'text-gray-500'}`}>Line</button>
                            <button onClick={() => setChartType('bar')} className={`p-1 rounded ${chartType === 'bar' ? 'text-brand-400' : 'text-gray-500'}`}>Bar</button>
                         </div>
                    </div>
                    
                    <div className="flex-1 w-full min-h-0">
                        <ResponsiveContainer width="100%" height="100%">
                            {chartType === 'line' ? (
                                <LineChart data={displayChartData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                    <XAxis 
                                        dataKey="timestamp" 
                                        domain={['auto', 'auto']}
                                        tickFormatter={(unix) => new Date(unix).toLocaleTimeString()} 
                                        stroke="#9ca3af"
                                        tick={{fontSize: 12}}
                                    />
                                    <YAxis stroke="#9ca3af" tick={{fontSize: 12}} />
                                    <RechartsTooltip 
                                        contentStyle={{backgroundColor: '#1f2937', borderColor: '#374151', color: '#fff'}}
                                        labelFormatter={(unix) => new Date(unix).toLocaleTimeString()}
                                    />
                                    <Line 
                                        type="monotone" 
                                        dataKey={selectedChartField} 
                                        stroke="#22c55e" 
                                        strokeWidth={2} 
                                        dot={false} 
                                        animationDuration={300}
                                    />
                                </LineChart>
                            ) : (
                                <BarChart data={displayChartData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                    <XAxis dataKey="timestamp" tick={false} stroke="#9ca3af"/>
                                    <YAxis stroke="#9ca3af" />
                                    <RechartsTooltip contentStyle={{backgroundColor: '#1f2937', borderColor: '#374151', color: '#fff'}}/>
                                    <Bar dataKey={selectedChartField} fill="#22c55e" />
                                </BarChart>
                            )}
                        </ResponsiveContainer>
                    </div>
                </Card>

                {/* Secondary Gauge / Stats */}
                <div className="flex flex-col gap-6 h-full">
                    {/* Gauge (Simple SVG implementation) */}
                    <Card className="flex-1 flex flex-col items-center justify-center relative" title="Current Value">
                        {selectedChartField ? (
                            <>
                                <svg viewBox="0 0 100 50" className="w-full h-full max-h-40">
                                    <path d="M10,50 A40,40 0 0,1 90,50" fill="none" stroke="#374151" strokeWidth="10" strokeLinecap="round"/>
                                    {latest && (
                                        <path 
                                            d="M10,50 A40,40 0 0,1 90,50" 
                                            fill="none" 
                                            stroke="#22c55e" 
                                            strokeWidth="10" 
                                            strokeLinecap="round"
                                            strokeDasharray="126" // approx len
                                            strokeDashoffset={126 - (Math.min(100, Math.max(0, latest[selectedChartField])) / 100) * 126} // Naive 0-100 scale for demo
                                            className="transition-all duration-500 ease-out"
                                        />
                                    )}
                                </svg>
                                <div className="absolute bottom-4 text-3xl font-bold text-white">
                                    {latest?.[selectedChartField]?.toFixed(1) ?? 0}
                                </div>
                                <div className="text-gray-500 text-xs mt-[-1rem]">Assuming 0-100 scale for gauge</div>
                            </>
                        ) : <div className="text-gray-500">Select a field</div>}
                    </Card>

                    {/* Scatter Plot Option */}
                    <Card className="flex-1" title="Scatter (X vs Y)">
                        <div className="h-full w-full min-h-[150px]">
                           {availableKeys.length >= 2 ? (
                               <ResponsiveContainer>
                                   <ScatterChart margin={{top: 10, right: 10, bottom: 10, left: 0}}>
                                       <XAxis type="number" dataKey={availableKeys[0]} name={availableKeys[0]} stroke="#6b7280" tick={{fontSize: 10}} />
                                       <YAxis type="number" dataKey={availableKeys[1]} name={availableKeys[1]} stroke="#6b7280" tick={{fontSize: 10}} />
                                       <RechartsTooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{backgroundColor: '#1f2937', borderColor: '#374151'}} />
                                       <Scatter name="Values" data={displayChartData} fill="#8884d8">
                                            {displayChartData.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                            ))}
                                       </Scatter>
                                   </ScatterChart>
                               </ResponsiveContainer>
                           ) : <div className="flex items-center justify-center h-full text-gray-500 text-xs">Need 2+ fields</div>}
                        </div>
                    </Card>
                </div>
            </div>

            {/* Bottom Controls */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                
                {/* Data Logging */}
                <Card title="Data Logger">
                    <div className="flex items-center gap-4 mb-4">
                        <Button 
                            variant={isRecording ? 'danger' : 'success'} 
                            onClick={() => {
                                setIsRecording(!isRecording);
                                if(!isRecording) sessionLog.current = [];
                            }}
                            className="flex items-center gap-2"
                        >
                            {isRecording ? 'Stop Recording' : 'Start Recording'}
                        </Button>
                        <div className="text-xs text-gray-400 font-mono">
                            Points Buffered: {isRecording ? sessionLog.current.length : 0}
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => exportData('csv')} className="text-xs flex items-center gap-2">
                            <Save size={14} /> Export CSV
                        </Button>
                        <Button variant="secondary" onClick={() => exportData('json')} className="text-xs flex items-center gap-2">
                            <Download size={14} /> Export JSON
                        </Button>
                    </div>
                </Card>

                {/* Command Center */}
                <Card title="Command Center (UART)">
                     <div className="flex gap-2 mb-4">
                         <div className="flex-1 relative">
                            <Terminal className="absolute left-3 top-2.5 text-gray-500" size={16} />
                            <input 
                                className="w-full bg-dark-900 border border-gray-700 rounded py-2 pl-9 pr-4 text-white focus:border-brand-500 focus:outline-none"
                                placeholder="Type command..."
                                value={cmdInput}
                                onChange={e => setCmdInput(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && sendCommand()}
                            />
                         </div>
                         <Button onClick={sendCommand}><Send size={16} /></Button>
                     </div>
                     <div className="flex gap-2 flex-wrap">
                        {/* Quick Actions Example */}
                        <Button variant="secondary" onClick={() => btService.send('LED_ON')} className="text-xs">LED ON</Button>
                        <Button variant="secondary" onClick={() => btService.send('LED_OFF')} className="text-xs">LED OFF</Button>
                        <Button variant="secondary" onClick={() => btService.send('BUZZ')} className="text-xs">BEEP</Button>
                     </div>
                     {parseErrors > 0 && (
                         <div className="mt-4 text-xs text-orange-400">
                             Warning: {parseErrors} malformed packets received.
                         </div>
                     )}
                </Card>

            </div>

        </main>
      </div>
    </div>
  );
};

export default App;
