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
      if (config.mode === 'UART') {
        // Many micro:bit firmwares do not advertise the UART service UUID,
        // so use acceptAllDevices to ensure it appears in the chooser.
        this.device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
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

      this.server = await this.device.gatt?.connect() || null;
      if (!this.server) throw new Error('Could not connect to GATT Server');

      let service: BluetoothRemoteGATTService | null = null;
      try {
        service = await this.server.getPrimaryService(serviceUUID);
      } catch (e: any) {
        if (e?.name === 'NotSupportedError' || e?.name === 'NotFoundError') {
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

      const characteristics = await service.getCharacteristics();
      const txUuid = config.txUUID.toLowerCase();
      const rxUuid = config.rxUUID.toLowerCase();
      const txChar = characteristics.find(c => c.uuid.toLowerCase() === txUuid) ||
        characteristics.find(c => c.properties.notify || c.properties.indicate);
      const rxChar = characteristics.find(c => c.uuid.toLowerCase() === rxUuid) ||
        characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse);

      if (!txChar) {
        throw new Error('UART TX characteristic (notify) not found.');
      }
      if (!rxChar) {
        throw new Error('UART RX characteristic (write) not found.');
      }

      await txChar.startNotifications();
      txChar.addEventListener('characteristicvaluechanged', (e: any) => {
        const value = new TextDecoder().decode(e.target.value);
        handleData(value);
      });

      this.rxCharacteristic = rxChar;

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
