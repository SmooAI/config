#!/usr/bin/env node
/**
 * Standalone entrypoint for the ESO bearer-token refresher (SMOODEV-1523).
 *
 * Built to `dist/eso-refresher/run.mjs` and exposed as the
 * `smooai-config-eso-refresher` bin. This is the process the sidecar container
 * runs; all behavior + the env contract live in `./index`.
 */
import { main } from './index';

void main();
