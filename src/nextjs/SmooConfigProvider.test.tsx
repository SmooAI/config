import { cleanup, render, screen } from '@testing-library/react';
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConfigClient } from '../react/ConfigProvider';
import { SmooConfigProvider } from './SmooConfigProvider';

// Mock fetch to prevent actual API calls
vi.stubGlobal('fetch', vi.fn());

const BASE_OPTIONS = {
    baseUrl: 'https://api.smooai.dev',
    apiKey: 'test-key',
    orgId: 'org-123',
    environment: 'production',
};

// Test component that reads from the config client
function TestConsumer({ configKey }: { configKey: string }) {
    const client = useConfigClient();
    const value = client.getCachedValue(configKey);
    return <div data-testid="value">{value !== undefined ? String(value) : 'NOT_FOUND'}</div>;
}

describe('SmooConfigProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
    });

    it('provides initial values synchronously to child components', () => {
        render(
            <SmooConfigProvider
                {...BASE_OPTIONS}
                initialValues={{
                    API_URL: 'https://api.example.com',
                    ENABLE_NEW_UI: 'true',
                }}
            >
                <TestConsumer configKey="API_URL" />
            </SmooConfigProvider>,
        );

        expect(screen.getByText('https://api.example.com')).toBeTruthy();
    });

    it('returns NOT_FOUND for keys not in initialValues', () => {
        render(
            <SmooConfigProvider {...BASE_OPTIONS} initialValues={{ API_URL: 'https://api.example.com' }}>
                <TestConsumer configKey="MISSING_KEY" />
            </SmooConfigProvider>,
        );

        expect(screen.getByText('NOT_FOUND')).toBeTruthy();
    });

    it('works without initialValues', () => {
        render(
            <SmooConfigProvider {...BASE_OPTIONS}>
                <TestConsumer configKey="API_URL" />
            </SmooConfigProvider>,
        );

        expect(screen.getByText('NOT_FOUND')).toBeTruthy();
    });
});
