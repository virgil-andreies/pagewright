import { describe, expect, it } from 'vitest';
import { maxSaveSourceMB } from '@pagewright/core';
import { webDevice } from '../src';

const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120';
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120 Mobile';
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';
const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'; // iPadOS pretends to be a Mac

const dev = (userAgent: string, deviceMemory?: number, maxTouchPoints = 0, mobile?: boolean) =>
  webDevice({ userAgent, maxTouchPoints, deviceMemory, ...(mobile === undefined ? {} : { userAgentData: { mobile } }) });

describe('webDevice', () => {
  it('scales the save budget with device memory on desktop', () => {
    expect(dev(desktop, 8).memoryBudgetMB).toBe(3072); // capped
    expect(dev(desktop, 4).memoryBudgetMB).toBe(1638);
    expect(dev(desktop, 1).memoryBudgetMB).toBe(768); // floor
  });

  it('is stricter on phones', () => {
    expect(dev(android, 4, 5).memoryBudgetMB).toBe(1200);
    expect(dev(android, 3, 5).memoryBudgetMB).toBe(922);
    expect(dev(iphone, undefined, 5).memoryBudgetMB).toBe(922); // Safari reports no memory: assume 3 GB
    expect(dev(android, 1, 5).memoryBudgetMB).toBe(512);
  });

  it('treats an iPad that reports itself as a Mac as a phone-class device', () => {
    expect(dev(ipad, undefined, 5).memoryBudgetMB).toBe(922);
  });

  it('prefers the browser-declared mobile flag', () => {
    expect(dev(desktop, 4, 0, true).memoryBudgetMB).toBe(1200);
    expect(dev(android, 4, 5, false).memoryBudgetMB).toBe(1638);
  });

  it('assumes 4 GB on a desktop browser that hides device memory', () => {
    expect(dev(desktop, undefined).memoryBudgetMB).toBe(1638);
  });

  it('gives the 299 MB test file a yes on a typical desktop and a no on a typical phone', () => {
    expect(maxSaveSourceMB(dev(desktop, 8).memoryBudgetMB)).toBeGreaterThan(299);
    expect(maxSaveSourceMB(dev(desktop, 4).memoryBudgetMB)).toBeGreaterThan(299);
    expect(maxSaveSourceMB(dev(android, 4, 5).memoryBudgetMB)).toBeLessThan(299);
    expect(maxSaveSourceMB(dev(iphone, undefined, 5).memoryBudgetMB)).toBeLessThan(299);
  });
});
