export * from './math.js';
export * from './rng.js';

/** Simulation ticks per second. All game time is expressed in ticks. */
export const TICK_RATE = 20;

// Simulation API: state model + ruleset compiler + match orchestrator.
export * from './sim/types.js';
export * from './sim/ruleset.js';
export * from './sim/sim.js';
export * from './sim/ai.js';
export * from './sim/vision.js';

// Client<->server wire protocol (shared by @bships/server and @bships/client).
export * from './protocol.js';
