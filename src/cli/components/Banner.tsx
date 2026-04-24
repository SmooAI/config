import { Box, Text } from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';
import React from 'react';
import { BRAND } from './brand';

/**
 * Choose a cfonts font that fits the current terminal width. `block` renders
 * the brand at full impact but needs ~50 columns. Fall back to `chrome` at
 * mid widths and `tiny` for narrow terminals / pipes.
 */
function pickFont(): 'block' | 'chrome' | 'tiny' {
    const cols = typeof process.stdout.columns === 'number' ? process.stdout.columns : 80;
    if (cols >= 66) return 'block';
    if (cols >= 44) return 'chrome';
    return 'tiny';
}

export function Banner({ title, subtitle }: { title: string; subtitle?: string }) {
    const font = pickFont();
    return (
        <Box marginBottom={1} flexDirection="column">
            <Gradient colors={[BRAND.orange, BRAND.teal]}>
                <BigText text="Smoo AI" font={font} space={false} />
            </Gradient>
            <Box flexDirection="row" marginTop={font === 'tiny' ? 0 : -1}>
                <Text color={BRAND.teal} bold>
                    {'smooai-config'}
                </Text>
                <Text color={BRAND.mutedOrange}> · </Text>
                <Text color={BRAND.darkBlue} bold>
                    {title}
                </Text>
                {subtitle ? (
                    <>
                        <Text color={BRAND.mutedOrange}> · </Text>
                        <Text color={BRAND.mutedOrange}>{subtitle}</Text>
                    </>
                ) : null}
            </Box>
        </Box>
    );
}
