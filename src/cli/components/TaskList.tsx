import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { useEffect, useState } from 'react';
import { BRAND } from './brand';

export interface TaskItem {
    label: string;
    status: 'pending' | 'running' | 'done' | 'error';
    error?: string;
    /** Optional epoch-ms timestamp — when present, rendered as an elapsed counter. */
    startedAt?: number;
    /** Short hint shown dim below the task. */
    hint?: string;
}

function Elapsed({ startedAt }: { startedAt: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(id);
    }, []);
    const secs = Math.max(0, (now - startedAt) / 1000);
    if (secs < 1) return null;
    return <Text color={BRAND.gray}> ({secs.toFixed(1)}s)</Text>;
}

export function TaskList({ tasks }: { tasks: TaskItem[] }) {
    return (
        <Box flexDirection="column" marginTop={1}>
            {tasks.map((task, i) => (
                <Box flexDirection="column" key={i}>
                    <Box>
                        <Box width={3}>
                            {task.status === 'running' && (
                                <Text color={BRAND.orange}>
                                    <Spinner type="dots3" />
                                </Text>
                            )}
                            {task.status === 'done' && <Text color={BRAND.teal}>✔</Text>}
                            {task.status === 'error' && <Text color={BRAND.red}>✖</Text>}
                            {task.status === 'pending' && <Text color={BRAND.gray}>○</Text>}
                        </Box>
                        <Text
                            color={
                                task.status === 'error' ? BRAND.red : task.status === 'done' ? BRAND.teal : task.status === 'running' ? undefined : BRAND.gray
                            }
                        >
                            {task.label}
                        </Text>
                        {task.status === 'running' && task.startedAt ? <Elapsed startedAt={task.startedAt} /> : null}
                        {task.error && <Text color={BRAND.red}> — {task.error}</Text>}
                    </Box>
                    {task.hint && task.status !== 'error' && (
                        <Box marginLeft={3}>
                            <Text color={BRAND.gray}>{task.hint}</Text>
                        </Box>
                    )}
                </Box>
            ))}
        </Box>
    );
}
