# Hono + Prisma (Neon) + JWT Backend

## Setup

1. Install dependencies.
2. Generate Prisma client.
3. Run migrations.
4. Start the server.

## Env

Copy `.env.example` to `.env` and fill values. The provided `.env` includes a placeholder JWT secret.

## Scripts

- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run prisma:generate`
- `npm run prisma:migrate`

## API

- `GET /api/health`
- `POST /api/auth/signup`
- `POST /api/auth/signin`
- `GET /api/auth/me`
- `GET /openapi.json`
- `GET /docs`

### Sign up

```bash
curl -X POST http://localhost:5000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"StrongPassw0rd!","firstName":"Ada","lastName":"Lovelace"}'
```

### Sign in

```bash
curl -X POST http://localhost:5000/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"StrongPassw0rd!"}'
```

### Me

```bash
curl -X GET http://localhost:5000/api/auth/me \
  -H "Authorization: Bearer <JWT_TOKEN>"
```
