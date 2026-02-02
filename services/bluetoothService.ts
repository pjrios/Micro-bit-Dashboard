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
  private async delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async connect(config: BluetoothConfig, handleData: (data: string) => void): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser.');
    }

    // Prepare filters. If UART, use 128-bit UUID. If Custom, we rely on user input.
    // Note: To access a service, it must be in optionalServices or filters.
    const serviceUUID = config.serviceUUID.toLowerCase();

    let step = 'requestDevice';
    try {
      if (config.mode === 'UART') {
        // Match micro:bit by name like the working legacy app.
        this.device = await navigator.bluetooth.requestDevice({
          filters: [
            { namePrefix: 'BBC micro:bit' },
            { namePrefix: 'micro:bit' }
          ],
          optionalServices: [serviceUUID]
        });
      } else {
        this.device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [serviceUUID] }],
          optionalServices: [serviceUUID]
        });
      }

      if (!this.device) throw new Error('No device selected');
      
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnect.bind(this));

      step = 'gattConnect';
      if (this.device.gatt?.connected) {
        this.server = this.device.gatt;
      } else {
        try {
          this.server = await this.device.gatt?.connect() || null;
        } catch (e: any) {
          if (e?.name === 'NotSupportedError') {
            // Retry once after disconnecting (device may be in a stale state).
            try { this.device.gatt?.disconnect(); } catch {}
            await this.delay(300);
            this.server = await this.device.gatt?.connect() || null;
          } else {
            throw e;
          }
        }
      }
      if (!this.server) throw new Error('Could not connect to GATT Server');

      let service: BluetoothRemoteGATTService | null = null;
      try {
        step = 'getPrimaryService';
        service = await this.server.getPrimaryService(serviceUUID);
      } catch (e: any) {
        if (e?.name === 'NotSupportedError' || e?.name === 'NotFoundError') {
          step = 'getPrimaryServices';
          const services = await this.server.getPrimaryServices();
          service = services.find(s => s.uuid.toLowerCase() === serviceUUID) || null;
        } else {
          throw e;
        }
      }
      if (!service) {
        throw new Error(
          'UART service not found. Ensure your micro:bit code calls bluetooth.startUartService() and sends data with bluetooth.uartWriteLine().'
        );
      }

      step = 'getCharacteristics';
      const characteristics = await service.getCharacteristics();
      const txUuid = config.txUUID.toLowerCase();
      const rxUuid = config.rxUUID.toLowerCase();
      const txByUuid = characteristics.find(c => c.uuid.toLowerCase() === txUuid);
      const rxByUuid = characteristics.find(c => c.uuid.toLowerCase() === rxUuid);
      const notifyChar = characteristics.find(c => c.properties.notify || c.properties.indicate);
      const writeChar = characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse);
      const txChar = txByUuid || notifyChar;
      const rxChar = rxByUuid || writeChar;

      if (!txChar) {
        throw new Error('UART TX characteristic (notify) not found.');
      }
      if (!rxChar) {
        throw new Error('UART RX characteristic (write) not found.');
      }

      step = 'startNotifications';
      const attachNotify = async (c: BluetoothRemoteGATTCharacteristic) => {
        await c.startNotifications();
        c.addEventListener('characteristicvaluechanged', (e: any) => {
          const value = new TextDecoder().decode(e.target.value);
          handleData(value);
        });
      };
      try {
        await attachNotify(txChar);
      } catch (e: any) {
        // Some firmwares swap UART TX/RX or do not allow notify on the expected UUID.
        if ((e?.name === 'NotSupportedError' || e?.message?.includes('Not supported')) && rxChar) {
          await attachNotify(rxChar);
        } else {
          throw e;
        }
      }

      step = 'ready';
      this.rxCharacteristic = rxChar;

    } catch (error: any) {
      if (error.name === 'NotFoundError' || error.message.toLowerCase().includes('cancel')) {
        console.warn('Bluetooth Connection: User cancelled device chooser.');
      } else {
        console.error(`Bluetooth Connection Error at ${step}:`, error);
      }
      const suffix = step ? ` (step: ${step})` : '';
      throw new Error(`${error.message || 'Connection failed'}${suffix}`);
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

  async diagnoseServices(): Promise<{ services: string[]; uartCharacteristics: string[] | null; }> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser.');
    }
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
      ]
    });
    const server = await device.gatt?.connect();
    if (!server) throw new Error('Could not connect to GATT Server');
    const services = await server.getPrimaryServices();
    const uuids = services.map(s => s.uuid);
    let uartCharacteristics: string[] | null = null;
    const uartService = services.find(s => s.uuid.toLowerCase() === '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
    if (uartService) {
      const chars = await uartService.getCharacteristics();
      uartCharacteristics = chars.map(c => c.uuid);
    }
    server.disconnect();
    return { services: uuids, uartCharacteristics };
  }
}

export const btService = new BluetoothService();
