import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from '../src/metadata.js';
import { rmSync, existsSync } from 'fs';

const TEST_DIR = '/tmp/organism-test-metadata';

describe('MetadataStore', () => {
  let store: MetadataStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new MetadataStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('chain history', () => {
    it('records a chain version', () => {
      store.recordChainVersion(['a', 'b'], 1, ['x', 'y'], 0.8);
      const history = store.getChainHistory(['a', 'b']);
      expect(history).toBeDefined();
      expect(history!.versions).toHaveLength(1);
      expect(history!.versions[0].intermediates).toEqual(['x', 'y']);
      expect(history!.rearrangementCount).toBe(0);
    });

    it('detects rearrangement when intermediates change', () => {
      store.recordChainVersion(['a', 'b'], 1, ['x', 'y'], 0.8);
      store.recordChainVersion(['a', 'b'], 10, ['z', 'w'], 0.9);
      const history = store.getChainHistory(['a', 'b']);
      expect(history!.rearrangementCount).toBe(1);
      expect(history!.versions).toHaveLength(2);
    });

    it('does not count same intermediates as rearrangement', () => {
      store.recordChainVersion(['a', 'b'], 1, ['x', 'y'], 0.8);
      store.recordChainVersion(['a', 'b'], 10, ['x', 'y'], 0.9);
      const history = store.getChainHistory(['a', 'b']);
      expect(history!.rearrangementCount).toBe(0);
    });

    it('looks up endpoints in sorted order', () => {
      store.recordChainVersion(['b', 'a'], 1, ['x'], 0.8);
      const history = store.getChainHistory(['a', 'b']);
      expect(history).toBeDefined();
      expect(history!.versions).toHaveLength(1);
    });

    it('getRearrangementEvents returns only histories with rearrangements', () => {
      store.recordChainVersion(['a', 'b'], 1, ['x'], 0.8);
      store.recordChainVersion(['a', 'b'], 10, ['y'], 0.9);
      store.recordChainVersion(['c', 'd'], 1, ['z'], 0.7);

      const events = store.getRearrangementEvents();
      expect(events).toHaveLength(1);
      expect(events[0].endpoints).toEqual(['a', 'b']);
    });
  });

  describe('identity snapshots', () => {
    it('stores and retrieves identity snapshot', () => {
      store.addIdentitySnapshot({
        run: 1,
        description: 'Initial topology.',
        topBridges: ['firewall'],
        dominantDomains: ['structural'],
        recentShifts: [],
      });

      const snapshot = store.getIdentityAt(1);
      expect(snapshot).toBeDefined();
      expect(snapshot!.description).toBe('Initial topology.');
    });

    it('returns latest identity', () => {
      store.addIdentitySnapshot({ run: 1, description: 'First', topBridges: [], dominantDomains: [], recentShifts: [] });
      store.addIdentitySnapshot({ run: 5, description: 'Fifth', topBridges: [], dominantDomains: [], recentShifts: [] });

      expect(store.getLatestIdentity()!.description).toBe('Fifth');
    });

    it('returns undefined when no snapshots exist', () => {
      expect(store.getLatestIdentity()).toBeUndefined();
      expect(store.getIdentityAt(1)).toBeUndefined();
    });

    it('getAllIdentitySnapshots returns all', () => {
      store.addIdentitySnapshot({ run: 1, description: 'A', topBridges: [], dominantDomains: [], recentShifts: [] });
      store.addIdentitySnapshot({ run: 2, description: 'B', topBridges: [], dominantDomains: [], recentShifts: [] });
      expect(store.getAllIdentitySnapshots()).toHaveLength(2);
    });
  });

  describe('bridge concepts', () => {
    it('stores and retrieves bridge concepts', () => {
      store.updateBridgeConcepts([
        { conceptId: 'c1', bridgeScore: 5.0, uniqueSourceInputs: 3, uniqueDomains: 2, chainsThrough: 8, discoveredAtRun: 5 },
      ]);

      const bridges = store.getBridgeConcepts();
      expect(bridges).toHaveLength(1);
      expect(bridges[0].bridgeScore).toBe(5.0);
    });

    it('replaces bridge concepts on update', () => {
      store.updateBridgeConcepts([
        { conceptId: 'c1', bridgeScore: 5.0, uniqueSourceInputs: 3, uniqueDomains: 2, chainsThrough: 8, discoveredAtRun: 5 },
      ]);
      store.updateBridgeConcepts([
        { conceptId: 'c2', bridgeScore: 7.0, uniqueSourceInputs: 4, uniqueDomains: 3, chainsThrough: 12, discoveredAtRun: 10 },
      ]);

      const bridges = store.getBridgeConcepts();
      expect(bridges).toHaveLength(1);
      expect(bridges[0].conceptId).toBe('c2');
    });
  });

  describe('persistence', () => {
    it('saves and reloads all data', () => {
      store.recordChainVersion(['a', 'b'], 1, ['x'], 0.8);
      store.addIdentitySnapshot({ run: 1, description: 'Test', topBridges: [], dominantDomains: [], recentShifts: [] });
      store.updateBridgeConcepts([
        { conceptId: 'c1', bridgeScore: 3.0, uniqueSourceInputs: 2, uniqueDomains: 1, chainsThrough: 4, discoveredAtRun: 1 },
      ]);

      const loaded = new MetadataStore(TEST_DIR);
      expect(loaded.getChainHistory(['a', 'b'])).toBeDefined();
      expect(loaded.getAllIdentitySnapshots()).toHaveLength(1);
      expect(loaded.getBridgeConcepts()).toHaveLength(1);
    });
  });

  describe('reset', () => {
    it('clears all data', () => {
      store.recordChainVersion(['a', 'b'], 1, ['x'], 0.8);
      store.addIdentitySnapshot({ run: 1, description: 'Test', topBridges: [], dominantDomains: [], recentShifts: [] });
      store.reset();

      expect(store.chainHistories).toHaveLength(0);
      expect(store.getAllIdentitySnapshots()).toHaveLength(0);
      expect(store.getBridgeConcepts()).toHaveLength(0);
    });
  });
});
