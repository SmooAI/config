import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React from 'react';

export interface TaskItem {
    label: string;
    status: 'pending' | 'running' | 'done' | 'error';
    error?: string;
}

export function TaskList({ tasks }: { tasks: TaskItem[] }) {
    return (
        <Box flexDirection="column" marginTop={1}>
            {tasks.map((task, i) => (
                <Box key={i}>
                    <Box width={3}>
                        {task.status === 'running' && (
                            <Text color="yellow">
                                <Spinner type="dots" />
                            </Text>
                        )}
                        {task.status === 'done' && <Text color="green">✓</Text>}
                        {task.status === 'error' && <Text color="red">✗</Text>}
                        {task.status === 'pending' && <Text color="gray">○</Text>}
                    </Box>
                    <Text color={task.status === 'error' ? 'red' : task.status === 'done' ? 'green' : undefined}>{task.label}</Text>
                    {task.error && <Text color="red"> — {task.error}</Text>}
                </Box>
            ))}
        </Box>
    );
}
