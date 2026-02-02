import { BluetoothConfig } from '../types';

// --- Web Bluetooth Type Definitions ---

interface BluetoothRequestDeviceFilter {
  services?: (string | number)[];
  name?: string;
  namePrefix?: string;
  manufacturerData?: any[];
  serviceData?: any[];
}

interface BluetoothRequestDeviceOptions {
  filters?: BluetoothRequestDeviceFilter[];
  optionalServices?: (string | number)[];
  acceptAllDevices?: boolean;
}

interface BluetoothRemoteGATTDescriptor {
  characteristic: BluetoothRemoteGATTCharacteristic;
  uuid: string;
  value?: DataView;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
}

interface BluetoothCharacteristicProperties {
  broadcast: boolean;
  read: boolean;
  writeWithoutResponse: boolean;
  write: boolean;
  notify: boolean;
  indicate: boolean;
  authenticatedSignedWrites: boolean;
  reliableWrite: boolean;
  writableAuxiliaries: boolean;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  service: BluetoothRemoteGATTService;
  uuid: string;
  properties: BluetoothCharacteristicProperties;
  value?: DataView;
  getDescriptor(descriptor: string | number): Promise<BluetoothRemoteGATTDescriptor>;
  getDescriptors(descriptor?: string | number): Promise<BluetoothRemoteGATTDescriptor[]>;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

interface BluetoothRemoteGATTService extends EventTarget {
  device: BluetoothDevice;
  uuid: string;
  isPrimary: boolean;
  getCharacteristic(characteristic: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
  getCharacteristics(characteristic?: string | number): Promise<BluetoothRemoteGATTCharacteristic[]>;
  getIncludedService(service: string | number): Promise<BluetoothRemoteGATTService>;
  getIncludedServices(service?: string | number): Promise<BluetoothRemoteGATTService[]>;
}

interface BluetoothRemoteGATTServer {
  device: BluetoothDevice;
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>;
  getPrimaryServices(service?: string | number): Promise<BluetoothRemoteGATTService[]>;
}

interface BluetoothDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
  watchAdvertisements(): Promise<void>;
  unwatchAdvertisements(): void;
  readonly watchingAdvertisements: boolean;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

interface Bluetooth {
  getAvailability(): Promise<boolean>;
  requestDevice(options?: BluetoothRequestDeviceOptions): Promise<BluetoothDevice>;
}

declare global {
  interface Navigator {
    bluetooth: Bluetooth;
  }
}

export class BluetoothService {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rxCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private onDisconnectCallback: (() => void) | null = null;

  async connect(config: BluetoothConfig, handleData: (data: string) => void): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser.');
    }

    // Prepare filters. If UART, use 128-bit UUID. If Custom, we rely on user input.
    // Note: To access a service, it must be in optionalServices or filters.
    const serviceUUID = config.serviceUUID.toLowerCase();

    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [serviceUUID] }],
        optionalServices: [serviceUUID]
      });

      if (!this.device) throw new Error('No device selected');
      
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnect.bind(this));

      this.server = await this.device.gatt?.connect() || null;
      if (!this.server) throw new Error('Could not connect to GATT Server');

      const service = await this.server.getPrimaryService(serviceUUID);
      
      // TX = Notify (Microbit sends to us)
      const txChar = await service.getCharacteristic(config.txUUID);
      await txChar.startNotifications();
      txChar.addEventListener('characteristicvaluechanged', (e: any) => {
        const value = new TextDecoder().decode(e.target.value);
        handleData(value);
      });

      // RX = Write (We send to Microbit)
      this.rxCharacteristic = await service.getCharacteristic(config.rxUUID);

    } catch (error: any) {
      if (error.name === 'NotFoundError' || error.message.toLowerCase().includes('cancel')) {
        console.warn('Bluetooth Connection: User cancelled device chooser.');
      } else {
        console.error('Bluetooth Connection Error:', error);
      }
      throw error;
    }
  }

  async send(data: string): Promise<void> {
    if (!this.rxCharacteristic) throw new Error('Not connected or RX characteristic not found');
    const encoder = new TextEncoder();
    // Microbit UART usually expects \n
    const value = encoder.encode(data.endsWith('\n') ? data : data + '\n');
    await this.rxCharacteristic.writeValue(value);
  }

  disconnect() {
    if (this.device && this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
  }

  setDisconnectCallback(cb: () => void) {
    this.onDisconnectCallback = cb;
  }

  private handleDisconnect() {
    this.device = null;
    this.server = null;
    this.rxCharacteristic = null;
    if (this.onDisconnectCallback) this.onDisconnectCallback();
  }

  isConnected(): boolean {
    return !!(this.device && this.device.gatt?.connected);
  }
}

export const btService = new BluetoothService();