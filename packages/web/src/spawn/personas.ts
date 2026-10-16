/**
 * Agent personas (Amendment 68) live in `@conductor/shared` since Amendment 176, so the daemon
 * reads the same built-ins and the same setting before every run. Re-exported here so Spawn,
 * Settings and their checks keep importing them from where they always did.
 */

export {
  BUILT_IN_PERSONAS,
  PERSONAS_KEY,
  isEdited,
  newPersonaId,
  personaFor,
  personasFrom,
  renamedPersona,
  resetPersona,
  withPersona,
  withoutPersona,
  type Persona,
  type PersonaTools,
} from '@conductor/shared';
