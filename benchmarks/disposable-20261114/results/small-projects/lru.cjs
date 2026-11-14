class LRUCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive integer');
    }
    this._capacity = capacity;
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  get(key) {
    if (!this._map.has(key)) {
      return undefined;
    }
    const value = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    this._map.set(key, value);
    if (this._map.size > this._capacity) {
      const lruKey = this._map.keys().next().value;
      this._map.delete(lruKey);
    }
    return this;
  }
}

module.exports = LRUCache;