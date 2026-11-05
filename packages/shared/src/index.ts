import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constantes del dominio. Único punto de verdad para la app y el backend:
// si mañana cambia el tamaño de los códigos o el límite de jugadores,
// ambas partes quedan sincronizadas sin tocar dos repositorios.
// ---------------------------------------------------------------------------

/** Longitud del código de invitación (sin caracteres ambiguos). */
export const GAME_CODE_LENGTH = 5;

/** Máximo de jugadores por partida (el anfitrión cuenta como primero). */
export const MAX_PLAYERS = 10;

/** Mínimo de jugadores para poder comenzar la partida. */
export const MIN_PLAYERS = 3;

/** Longitud del token de acceso privado (en bytes, antes de hex-encode). */
export const ACCESS_TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Validación de entradas. Las mismas reglas se aplican en la app (feedback
// inmediato al usuario) y en el backend (fuente de verdad: nunca se confía
// en lo que envía el cliente).
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const gameCodeSchema = z
  .string()
  .transform((v) => v.trim().toUpperCase().replace(/[\s-]/g, '')) //Transforma el codigo, elimina espacios con trim, convierte letras a mayusculas y elimina espacios o guiones
  .pipe( //Valida el resultado de la transformación, si no cumple con las reglas, devuelve un error 
    z.string()
      .length(GAME_CODE_LENGTH, `El código debe tener ${GAME_CODE_LENGTH} caracteres`)
      .regex( //Comprueba que la expresion regular contiene los caracteres permitidos, si no devuelve un error
        new RegExp(`^[${CODE_ALPHABET}]+$`),
        'El código solo admite letras y números (sin O, I, 0 ni 1)',
      ),
  );

export const displayNameSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ' ').trim())
  .pipe(
    z.string()
      .min(2, 'El nombre debe tener al menos 2 caracteres')
      .max(20, 'El nombre no puede superar los 20 caracteres'),
  );

/**
 * Identidad estable del dispositivo: la genera la app, vive en SecureStore y
 * viaja en cada create/join. El backend la HASEA y la usa como clave de la
 * sesión activa; así se garantiza (no solo en la UI) que cada dispositivo
 * solo pertenezca a una partida a la vez, incluso con peticiones concurrentes.
 */
export const deviceIdSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(8, 'Identificador de dispositivo inválido')
      .max(64, 'Identificador de dispositivo inválido')
      .regex(/^[A-Za-z0-9-]+$/, 'Identificador de dispositivo inválido'),
  );

export const createGameSchema = z.object({
  displayName: displayNameSchema,
  deviceId: deviceIdSchema,
});

export const joinGameSchema = z.object({
  code: gameCodeSchema,
  displayName: displayNameSchema,
  deviceId: deviceIdSchema,
});

// ---------------------------------------------------------------------------
// Perfil del jugador y relaciones. La completitud de un perfil la decide el
// backend; aquí solo definimos forma y límites de los datos.
// ---------------------------------------------------------------------------

const PROFILE_TEXT_MAX = 600;
const RELATION_TEXT_MAX = 200;

/** Texto libre del perfil: se normaliza (trim) pero se admite vacío, porque
 *  guardarse incompleto es válido; lo que no vale es exceder los límites. */
const profileTextSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().max(PROFILE_TEXT_MAX, `Máximo ${PROFILE_TEXT_MAX} caracteres`));

/** Relación con otro jugador concreto: nivel 0-10 y descripción opcional. */
export const playerRelationSchema = z.object({
  level: z
    .number()
    .int('La valoración debe ser un número entero')
    .min(0, 'El nivel mínimo es 0')
    .max(10, 'El nivel máximo es 10'),
  description: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().max(RELATION_TEXT_MAX, `Máximo ${RELATION_TEXT_MAX} caracteres`)),
});

export const playerProfileSchema = z.object({
  aboutMe: profileTextSchema,
  job: profileTextSchema,
  clothing: profileTextSchema,
  hobbies: profileTextSchema,
  drinks: profileTextSchema,
  fears: profileTextSchema,
});

/** Cuerpo de PATCH /games/:id/profile. Los ids objetivo de las relaciones se
 *  verifican contra los jugadores reales de la partida en el backend. */
export const updatePlayerProfileSchema = z.object({
  profile: playerProfileSchema,
  relations: z.record(z.string(), playerRelationSchema),
});

// ---------------------------------------------------------------------------
// Contratos de la API. Tipos derivados de los schemas para que un documento
// de Firestore y una respuesta HTTP nunca se desalineen.
// ---------------------------------------------------------------------------

export type GameCode = z.infer<typeof gameCodeSchema>;
export type DisplayedName = z.infer<typeof displayNameSchema>;
export type CreateGameInput = z.infer<typeof createGameSchema>;
export type JoinGameInput = z.infer<typeof joinGameSchema>;
export type PlayerProfile = z.infer<typeof playerProfileSchema>;
export type PlayerRelation = z.infer<typeof playerRelationSchema>;
export type UpdatePlayerProfileInput = z.infer<typeof updatePlayerProfileSchema>;
/**
 * Estado del ciclo de vida de la partida. Las transiciones las controla
 * SIEMPRE el backend (ninguna escritura de estado proviene del cliente):
 *
 *   open ──(start, host, condiciones válidas)──▶ generating
 *   generating ──(éxito)──▶ ready
 *   generating ──(fallo)──▶ generation_error
 *   generation_error ──(reintento del anfitrión)──▶ generating
 *   cualquier estado ──(abandono del anfitrión)──▶ closed
 *
 * 'in_progress' se conserva por compatibilidad con partidas ya existentes;
 * el flujo actual ya no lo establece (la fase de juego es otra iteración).
 */
export type GameStatus =
  | 'open'
  | 'generating'
  | 'ready'
  | 'generation_error'
  | 'in_progress'
  | 'closed';

/** Vista pública de un jugador: nunca incluye el hash del token ni datos privados. */
export interface PlayerView {
  id: string;
  displayName: string;
  isHost: boolean;
  /**
   * Estado del perfil (decidido por el backend): undefined = sin tocar
   * (indicador gris), true = completado (tick verde), false = incompleto
   * (cruz roja). El contenido del perfil NUNCA viaja en esta vista.
   */
  profileCompleted?: boolean;
}

/** Vista pública de una partida: el código es lo único que se comparte por chat. */
export interface GameView {
  id: string;
  code: string;
  status: GameStatus;
  hostPlayerId: string;
  maxPlayers: number;
  playerCount: number;
}

/** Respuesta al crear o unirse: contiene el token privado, que viaja una única vez. */
export interface GameSessionPayload {
  game: GameView;
  player: PlayerView;
  /** Credencial privada de 64 caracteres hex. Guardar en almacenamiento seguro. */
  token: string;
}

/** Lista de jugadores de la partida, obtenida con credencial privada. */
export interface GameStatePayload {
  game: GameView;
  players: PlayerView[];
  /** Perfil y relaciones del LLAMADOR únicamente: los perfiles ajenos no viajan. */
  myProfile?: PlayerProfile | null;
  myRelations?: Record<string, PlayerRelation>;
  /** Último fallo de generación (solo visible con 'generation_error'). */
  lastGenerationError?: GenerationErrorView | null;
}

/** Respuesta al guardar el perfil: el backend decide si quedó completo. */
export interface UpdateProfilePayload {
  profileCompleted: boolean;
}

// ---------------------------------------------------------------------------
// Contexto de generación del misterio. Lo construye el BACKEND desde
// Firestore y viaja al proveedor de IA. Contrato de salida estable: si
// mañana se añaden campos, se hace al final de cada objeto sin renombrar
// los existentes para no romper proveedores ya integrados.
// ---------------------------------------------------------------------------

/** Relación especial redactada (con descripción) hacia otro participante. */
export interface MysterySpecialRelationship {
  targetPlayerId: string;
  description: string;
}

/** Valoración de afinidad (0-10) hacia otro participante. */
export interface MysteryRelationship {
  targetPlayerId: string;
  level: number;
}

/** Perfil personal tal como lo consume el proveedor de IA. */
export interface MysteryPlayerProfile {
  description: string;
  occupation: string;
  clothing: string;
  habitsAndHobbies: string;
  drinks: string;
  fears: string;
}

/** Participante del contexto: identificadores estables + perfil + relaciones. */
export interface MysteryPlayerContext {
  playerId: string;
  username: string;
  isHost: boolean;
  profile: MysteryPlayerProfile;
  specialRelationships: MysterySpecialRelationship[];
  relationships: MysteryRelationship[];
}

/** Contexto completo de la partida que se envía al proveedor de IA. */
export interface MysteryContext {
  gameId: string;
  gameCode: string;
  hostId: string;
  participantCount: number;
  players: MysteryPlayerContext[];
}

/** Último fallo de generación persistido; alimenta el mensaje junto al
 *  botón de inicio (el cliente no recibe trazas técnicas del proveedor). */
export interface GenerationErrorView {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Vista del misterio para el JUGADOR (FASE 6). El backend la construye
// filtrando games/{id}/mystery/current: cada jugador recibe SU personaje
// (con su información privada) y solo la información compartida. La
// solution, la resolución del crimen y la verdad absoluta de la cronología
// NUNCA viajan al cliente; el rol de asesino/cómplice solo aparece en la
// vista de quien lo desempeña.
// ---------------------------------------------------------------------------

/**
 * Pista visible para el llamador. SOLO el nombre viaja aquí: el contenido
 * sale del backend al descubrirla (transacción atómica) o dentro de
 * DiscoveredClueView para las que ESTE jugador ya descubrió. Así el texto
 * de una pista jamás está en el móvil de quien no la descubrió.
 */
export interface MysteryClueView {
  clueId: string;
  name: string;
  knownToMe: boolean;
}

/** Habitación con SOLO las pistas visibles para el llamador. */
export interface MysteryRoomView {
  roomId: string;
  name: string;
  description: string;
  clues: MysteryClueView[];
}

/** Momento de la cronología: solo lo que la partida puede saber (never el evento objetivo). */
export interface MysteryTimelinePointView {
  time: string;
  publicKnowledge: string;
}

/** Ficha pública de otro personaje: para sospechar, nada de su vida privada. */
export interface MysteryCharacterBriefView {
  characterId: string;
  playerId: string;
  name: string;
  /** Retrato del personaje tal como lo conoce la mesa: nunca secretos. */
  description: string;
  publicInfo: string;
}

/** Personaje asignado al llamador: incluye SU información privada. */
export interface MysteryCharacterPrivateView {
  characterId: string;
  playerId: string;
  name: string;
  description: string;
  publicInfo: string;
  privateInfo: string;
  secrets: string;
  objectives: string[];
  /**
   * Cronología INDIVIDUAL del personaje: sus momentos, lugares real y con
   * quién se cruzó. Es información privada SUYA (nadie más la recibe) y
   * alimenta "Mi cronología" (pantalla de introducción) y el menú lateral.
   */
  personalTimeline: MysteryPersonalTimelinePoint[];
  isVictim: boolean;
  /** Solo true si el llamador ES el asesino (nunca el flag ajeno). */
  isMurderer?: boolean;
  /** Solo true si el llamador ES el cómplice. */
  isAccomplice?: boolean;
}

/**
 * Punto de la cronología individual. Los involvedCharacterIds citan
 * characterIds del propio misterio; el cliente los resuelve a nombres con
 * la paleta de personajes de su vista (el backend los validó contra el
 * contexto, así que no puede venirse uno inventado).
 */
export interface MysteryPersonalTimelinePoint {
  /** Hora (HH:MM) del momento. */
  time: string;
  /** Ubicación del personaje en ese momento. */
  location: string;
  /** Qué hizo realmente (la verdad de SU itinerario). */
  event: string;
  /** Interacciones: characterIds de los personajes presentes. */
  involvedCharacterIds: string[];
  /** Lo que este personaje declara sobre el momento (puede mentir u ocultar). */
  publicClaim: string;
}

/** Respuesta completa a GET /games/{id}/mystery para el jugador que llama. */
export interface MysteryPayloadView {
  title: string;
  setting: string;
  synopsis: string;
  victim: { name: string; deathDetail: string };
  myCharacter: MysteryCharacterPrivateView;
  otherCharacters: MysteryCharacterBriefView[];
  rooms: MysteryRoomView[];
  timeline: MysteryTimelinePointView[];
}

// ---------------------------------------------------------------------------
// FASE DE INVESTIGACIÓN. Tras la pantalla de introducción, los jugadores
// exploran habitaciones y DESCUBREN pistas: cada pista la puede descubrir
// exactamente UN jugador (atomicidad garantizada en el backend con una
// transacción de Firestore, nunca en el cliente). Estado sincronizado por
// sondeo (el backend no tiene canales push: misma cadencia que el lobby).
//
// Almacenamiento (solo vía Admin SDK; las reglas de Firestore deniegan todo):
//   games/{id}/clues/{clueId}:
//     { status: 'reserved' | 'discovered', byPlayerId, reservedAt?, discoveredAt? }
//   games/{id}/notebooks/{playerId}:
//     { content, updatedAt } — cuaderno privado de cada jugador.
// ---------------------------------------------------------------------------

/** Estado de una pista para el llamador. */
export type ClueDiscoveryStatus = 'available' | 'reserved' | 'discovered';

/** Estado vivo de una pista: sincroniza los botones de la habitación. */
export interface MysteryClueStateView {
  clueId: string;
  roomId: string;
  status: ClueDiscoveryStatus;
  /** Quien la tiene reservada/descubierta; null mientras esté libre. */
  byPlayerId: string | null;
}

/** Pista descubierta POR EL LLAMADOR: con su contenido íntegro. */
export interface DiscoveredClueView {
  clueId: string;
  name: string;
  content: string;
  /** ISO 8601 del momento del descubrimiento (ordenar en el menú). */
  discoveredAt?: string;
}

/** Cuaderno personal del llamador (contenido + última escritura). */
export interface NotebookView {
  content: string;
  updatedAt: string | null;
}

/** Respuesta a GET /games/{id}/investigation para el jugador que llama. */
export interface InvestigationStatePayload {
  clueStates: MysteryClueStateView[];
  /** Pistas que ESTE jugador ya descubrió (para su menú lateral). */
  myDiscoveredClues: DiscoveredClueView[];
  notebook: NotebookView;
}

/** Respuesta a POST .../claim: la pista quedó RESERVADA para el llamador. */
export interface ClueClaimPayload {
  status: 'reserved';
}

/** Contenido íntegro de la pista, tras confirmar la reserva del llamador. */
export interface ClueRevealPayload {
  clueId: string;
  name: string;
  content: string;
}

/** Respuesta al liberar/persistentizar: forma estable de "hecho". */
export interface NotebookWritePayload {
  ok: boolean;
}

/** Tamaño máximo del cuaderno (caracteres): protege el backend del abuso. */
export const NOTEBOOK_TEXT_MAX = 20_000;

/** Cuerpo de GET/PUT /games/:id/notebook. Sin trim: el cuaderno respeta
 *  saltos de línea y espaciados tal como los escribe el jugador. */
export const notebookUpdateSchema = z.object({
  content: z
    .string()
    .max(NOTEBOOK_TEXT_MAX, `El cuaderno no puede superar los ${NOTEBOOK_TEXT_MAX} caracteres`),
});

export type NotebookUpdateInput = z.infer<typeof notebookUpdateSchema>;

// ---------------------------------------------------------------------------
// Códigos de error estables. La app los usa para mostrar el mensaje correcto
// sin depender de textos HTTP; el backend los emite siempre en el mismo campo.
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'GAME_NOT_FOUND'
  | 'GAME_CLOSED'
  | 'GAME_FULL'
  | 'GAME_NOT_HOST'
  | 'GAME_IN_PROGRESS'
  | 'ALREADY_IN_GAME'
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'BACKEND_NOT_CONFIGURED'
  | /** Condiciones de inicio incumplidas (mínimo de jugadores, perfiles pendientes). */
  'GAME_NOT_READY'
  | /** Ya existe una generación en curso para esta partida. */
  'GENERATION_IN_PROGRESS'
  | /** Proveedor de IA sin configurar (503 controlado, § integración IA). */
  'GENERATION_NOT_CONFIGURED'
  | /** El misterio todavía no está listo para jugarse (409 controlado). */
  'MYSTERY_NOT_READY'
  | /** La pista no existe, no es elegible para el llamador, está reservada por otro o ya descubierta. */
  'CLUE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'NOT_FOUND'
  | 'NETWORK_ERROR';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Utilidades. Normalizar el código en "shared" evita que "AB-CD1" funcione en
// la app y falle en el backend (o al revés).
// ---------------------------------------------------------------------------

/**
 * Normaliza lo que el usuario teclea antes de validar: mayúsculas, sin
 * espacios ni guiones. Devuelve también si tiene el formato básico correcto,
 * para deshabilitar botones sin mostrar errores agresivos mientras escribe.
 */
export function normalizeGameCode(raw: string): { value: string; looksValid: boolean } { //Recibe el texto en raw, lo transforma a mayusculas y elimina espacios o guiones, luego valida si cumple con las reglas de longitud y caracteres permitidos

  const value = raw.toUpperCase().replace(/[\s-]/g, '');
  const looksValid = new RegExp(`^[${CODE_ALPHABET}]{${GAME_CODE_LENGTH}}$`).test(value);
  return { value, looksValid };
}

/** Alfabeto expuesto para tests y generadores; mantenlo sin 0, O, 1, I, L. */
export const CODE_ALPHABET_SET = CODE_ALPHABET;
