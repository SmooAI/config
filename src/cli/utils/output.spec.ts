import { describe, it, expect } from 'vitest';
import { isInteractive } from './output';

describe('output utils', () => {
    describe('isInteractive', () => {
        it('returns false when json flag is true', () => {
            expect(isInteractive(true)).toBe(false);
        });

        it('returns false when no TTY', () => {
            const originalIsTTY = process.stdout.isTTY;
            Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
            expect(isInteractive(false)).toBe(false);
            Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
        });

        it('returns true when TTY and no json flag', () => {
            const originalIsTTY = process.stdout.isTTY;
            Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
            expect(isInteractive(false)).toBe(true);
            Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
        });
    });
});
