import { SoundAsset } from '../types';

const DB_NAME = 'MicroBitDashDB';
const STORE_NAME = 'sounds';
const DB_VERSION = 1;

export const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
};

export const saveSound = async (sound: SoundAsset): Promise<void> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    // We don't save the transient URL
    const { url, ...storable } = sound; 
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(storable);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getSounds = async (): Promise<SoundAsset[]> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
        const results = request.result as SoundAsset[];
        // Re-create URLs
        const withUrls = results.map(s => ({
            ...s,
            url: URL.createObjectURL(s.blob)
        }));
        resolve(withUrls);
    };
    request.onerror = () => reject(request.error);
  });
};

export const deleteSound = async (id: string): Promise<void> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};