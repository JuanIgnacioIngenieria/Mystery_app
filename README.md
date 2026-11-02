# Mystery — primera iteración

Juego social de misterio: anfitriones crean partidas privadas y los amigos se unen con un código de invitación. Esta versión entrega la pantalla inicial y los flujos **Create Game / Join Game** de punta a punta, con una base arquitectónica lista para perfiles, casos, pistas y votaciones.

## Estructura

```
apps/
  mobile/            Expo SDK 57 + TypeScript (expo-router, reanimated, secure-store)
  api/               Node + Express + Firebase Admin (Firestore)
packages/
  shared/            Contrato único: schemas zod, tipos y constantes app↔backend
firestore.rules      Deny-all: los clientes nunca tocan Firestore directamente
```

## Decisiones de seguridad

- **Credenciales ≠ código.** Al crear o unirse, el backend emite un token privado de 128 bits (una sola vez). Se guarda en el Keychain/Keystore (`expo-secure-store`) y en Firestore solo su **hash SHA-256**.
- **Códigos impredecibles**: CSPRNG, 5 caracteres, sin 0/O/1/I/L.
- **Firestore sellado**: reglas `deny all` para clientes; toda lectura/escritura pasa por el backend con validación zod y autorización por token.
- **Joins concurrentes** resueltos con transacciones de Firestore (existencia + estado + cupo se revalidan atómicamente).
- **Rate limiting** en memoria por IP+ruta para creación/unión (sin Redis en esta fase).
- **Sin secretos en el cliente**: la app móvil no conoce Firebase; ni llaves de admin ni de proveedores de IA salen del backend.

## Setup

Requisitos: Node 22+, npm 10+, proyecto de Firebase con Cloud Firestore.

### 1) Backend

```bash
cp apps/api/.env.example apps/api/.env
# Edita apps/api/.env con las credenciales de la cuenta de servicio de Firebase.
# (Google Cloud Console → IAM → Cuentas de servicio → clave JSON;
#  la PRIVATE_KEY va en una línea con los saltos como \n)
```

Crea en Firebase un proyecto con Firestore (modo producción) y despliega las reglas:

```bash
firebase deploy --only firestore:rules   # Firebase CLI instalado y proyecto elegido
```

### 2) App móvil

```bash
npm install          # en la raíz: instala todos los workspaces
npx expo start       # dentro de apps/mobile
```

Abre el proyecto en **Expo Go** (escanea el QR). El backend por defecto se deduce del host del dev server de Expo (`http://<tu-ip>:4000/api`); se puede fijar con `EXPO_PUBLIC_API_URL`.

### Variables de entorno

| Variable | Dónde | Para qué |
| --- | --- | --- |
| `PORT` | apps/api/.env | Puerto del backend (4000 por defecto) |
| `FIREBASE_PROJECT_ID` | apps/api/.env | Proyecto Firestore |
| `FIREBASE_CLIENT_EMAIL` | apps/api/.env | Email de la cuenta de servicio |
| `FIREBASE_PRIVATE_KEY` | apps/api/.env | Clave privada (una línea, `\n` escapados) |
| `EXPO_PUBLIC_API_URL` | apps/mobile/.env | URL del backend cuando no es deducible del host de Expo |

## Comandos

> ⚠️ **Arranca los comandos Expo siempre desde `apps/mobile`** (o con `npm run mobile` en la raíz).
> Ejecutar `npx expo start` en la raíz del monorepo falla: la raíz no es un proyecto Expo y el CLI
> recurre al entry heredado `expo/AppEntry` (busca un `App.js` que no existe aquí).

```bash
npm run mobile                  # desde la raíz: expo start en apps/mobile
npm run api                     # desde la raíz: backend con tsx watch

# Backend
npm run dev -w apps/api         # tsx watch en :4000
npm test -w apps/api            # vitest (lógica pura: códigos, tokens, rate limit)
npm run typecheck -w apps/api

# Móvil (dentro de apps/mobile)
npx expo start
npm run lint -w apps/mobile
npm run typecheck -w apps/mobile

# Shared
npm test -w packages/shared
```

## Verificación del setup

- `GET http://localhost:4000/api/games/health` → `{ "ok": true, "database": "firebase" }`. Si responde `not_configured`, revisa el `.env` del backend.
- Sin credenciales el backend arranca igual, y los endpoints de partida responden `503` con instrucciones (nunca datos fake).

## Próximos pasos (fuera de alcance aquí)

Perfil de personaje, generación de misterio con IA, pistas privadas, notas y votaciones. La autorización por token del lobby (`GET /games/:id/state`) es el patrón a extender.
