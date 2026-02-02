export interface DataPoint {
  timestamp: number;
  [key: string]: number;
}

export type ParseMode = 'JSON' | 'CSV';

export interface BluetoothConfig {
  serviceUUID: string;
  txUUID: string; // Notify
  rxUUID: string; // Write
  mode: 'UART' | 'CUSTOM';
}

export const UART_CONFIG: BluetoothConfig = {
  serviceUUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  txUUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  rxUUID: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  mode: 'UART'
};

export interface SoundAsset {
  id: string;
  name: string;
  blob: Blob;
  url?: string; // transient object URL
}

export type RuleOperator = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'between';

export interface Rule {
  id: string;
  name: string;
  field: string;
  operator: RuleOperator;
  threshold1: number;
  threshold2?: number; // for 'between'
  soundId: string;
  cooldown: number; // ms
  lastTriggered: number;
  active: boolean;
  smoothingSamples: number; // 1 = no smoothing
}

export interface ChartConfig {
  field: string;
  type: 'line' | 'bar' | 'area' | 'scatter';
  color: string;
  min?: number;
  max?: number;
}