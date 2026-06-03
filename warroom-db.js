/**
 * War Room — Storage Layer
 * IndexedDB wrapper for construction sites and photos.
 * Swappable abstraction: replace this module with a Supabase client later
 * without touching warroom.js UI code.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'warroom';
  const DB_VERSION = 1;
  const SITES_STORE = 'sites';
  const PHOTOS_STORE = 'photos';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(SITES_STORE)) {
          db.createObjectStore(SITES_STORE, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(PHOTOS_STORE)) {
          const photosStore = db.createObjectStore(PHOTOS_STORE, { keyPath: 'id' });
          photosStore.createIndex('siteId', 'siteId', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  }

  function tx(storeNames, mode) {
    return openDB().then((db) => {
      const transaction = db.transaction(storeNames, mode);
      return {
        db,
        transaction,
        stores: storeNames.reduce((acc, name) => {
          acc[name] = transaction.objectStore(name);
          return acc;
        }, {})
      };
    });
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function generateId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType || 'image/jpeg' });
  }

  const WarRoomDB = {
    generateId,

    async getAllSites() {
      const { stores } = await tx([SITES_STORE], 'readonly');
      const sites = await promisifyRequest(stores[SITES_STORE].getAll());
      return sites.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    },

    async getSite(id) {
      const { stores } = await tx([SITES_STORE], 'readonly');
      return promisifyRequest(stores[SITES_STORE].get(id));
    },

    async saveSite(site) {
      const now = new Date().toISOString();
      const record = {
        ...site,
        updatedAt: now,
        createdAt: site.createdAt || now
      };

      const { stores } = await tx([SITES_STORE], 'readwrite');
      await promisifyRequest(stores[SITES_STORE].put(record));
      return record;
    },

    async deleteSite(id) {
      const photos = await this.getPhotosBySite(id);

      const { stores } = await tx([SITES_STORE, PHOTOS_STORE], 'readwrite');
      await promisifyRequest(stores[SITES_STORE].delete(id));

      for (const photo of photos) {
        await promisifyRequest(stores[PHOTOS_STORE].delete(photo.id));
      }
    },

    async getPhotosBySite(siteId) {
      const { stores } = await tx([PHOTOS_STORE], 'readonly');
      const index = stores[PHOTOS_STORE].index('siteId');
      return promisifyRequest(index.getAll(siteId));
    },

    async savePhoto(siteId, blob, filename) {
      const id = generateId();
      const record = {
        id,
        siteId,
        blob,
        filename: filename || 'photo.jpg',
        mimeType: blob.type || 'image/jpeg',
        createdAt: new Date().toISOString()
      };

      const { stores } = await tx([PHOTOS_STORE], 'readwrite');
      await promisifyRequest(stores[PHOTOS_STORE].put(record));
      return record;
    },

    async deletePhoto(photoId) {
      const { stores } = await tx([PHOTOS_STORE], 'readwrite');
      await promisifyRequest(stores[PHOTOS_STORE].delete(photoId));
    },

    async getPhoto(photoId) {
      const { stores } = await tx([PHOTOS_STORE], 'readonly');
      return promisifyRequest(stores[PHOTOS_STORE].get(photoId));
    },

    async exportAll() {
      const sites = await this.getAllSites();
      const photosExport = [];

      for (const site of sites) {
        const photos = await this.getPhotosBySite(site.id);
        for (const photo of photos) {
          photosExport.push({
            id: photo.id,
            siteId: photo.siteId,
            filename: photo.filename,
            mimeType: photo.mimeType,
            createdAt: photo.createdAt,
            data: await blobToBase64(photo.blob)
          });
        }
      }

      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        sites: sites.map((site) => ({
          ...site,
          photoIds: undefined
        })),
        photos: photosExport
      };
    },

    async importAll(data, mode = 'replace') {
      if (!data || !Array.isArray(data.sites)) {
        throw new Error('Formato de backup inválido');
      }

      if (mode === 'replace') {
        await this.clearAll();
      }

      const { stores } = await tx([SITES_STORE, PHOTOS_STORE], 'readwrite');

      for (const site of data.sites) {
        await promisifyRequest(stores[SITES_STORE].put(site));
      }

      if (Array.isArray(data.photos)) {
        for (const photo of data.photos) {
          const blob = base64ToBlob(photo.data, photo.mimeType);
          await promisifyRequest(stores[PHOTOS_STORE].put({
            id: photo.id,
            siteId: photo.siteId,
            blob,
            filename: photo.filename,
            mimeType: photo.mimeType,
            createdAt: photo.createdAt
          }));
        }
      }
    },

    async clearAll() {
      const { stores } = await tx([SITES_STORE, PHOTOS_STORE], 'readwrite');
      await promisifyRequest(stores[SITES_STORE].clear());
      await promisifyRequest(stores[PHOTOS_STORE].clear());
    }
  };

  global.WarRoomDB = WarRoomDB;
})(window);
