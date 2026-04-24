import { Box, Text } from 'ink';
import React from 'react';
import { BRAND } from './brand';

export interface PanelRow {
    label: string;
    value: string;
    color?: string;
}

export function SummaryPanel({ title, rows, accent = BRAND.teal }: { title: string; rows: PanelRow[]; accent?: string }) {
    const labelWidth = Math.max(...rows.map((r) => r.label.length), 4) + 1;
    return (
        <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginY={1}>
            <Text color={accent} bold>
                {title}
            </Text>
            {rows.map((r, i) => (
                <Box key={i}>
                    <Box width={labelWidth}>
                        <Text color={BRAND.gray}>{r.label}</Text>
                    </Box>
                    <Text color={r.color ?? undefined}>{r.value}</Text>
                </Box>
            ))}
        </Box>
    );
}

export function SuccessPanel({ title, children }: { title: string; children?: React.ReactNode }) {
    return (
        <Box flexDirection="column" borderStyle="round" borderColor={BRAND.teal} paddingX={1} marginY={1}>
            <Text color={BRAND.teal} bold>
                {'✔ '}
                {title}
            </Text>
            {children}
        </Box>
    );
}

export function ErrorPanel({ title, message, hint }: { title: string; message: string; hint?: string }) {
    return (
        <Box flexDirection="column" borderStyle="round" borderColor={BRAND.red} paddingX={1} marginY={1}>
            <Text color={BRAND.red} bold>
                {'✖ '}
                {title}
            </Text>
            <Text color={BRAND.red}>{message}</Text>
            {hint ? (
                <Box marginTop={1}>
                    <Text color={BRAND.yellow}>{'Try: '}</Text>
                    <Text color={BRAND.gray}>{hint}</Text>
                </Box>
            ) : null}
        </Box>
    );
}
