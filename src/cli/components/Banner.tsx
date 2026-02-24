import { Box, Text } from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';
import React from 'react';

export function Banner({ title }: { title: string }) {
    return (
        <Box marginBottom={1} flexDirection="column">
            <Gradient colors={['#f49f0a', '#ff6b6c']}>
                <BigText text="Smoo AI" font="tiny" />
            </Gradient>
            <Text bold>{title}</Text>
        </Box>
    );
}
