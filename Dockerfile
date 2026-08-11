# Parallax ships as one process that serves the API, the portal, and -- through
# the same command layer -- the CLI. All three are in this image on purpose:
# an operator with a shell in the container can drive the control plane without
# a token, because the command line reaches the store directly.
#
# The base tracks `engines.node` in package.json. If one moves, move the other:
# a build that passes on an older runtime only proves nothing 24-only is in use
# *yet*, and the day that changes it breaks at runtime, not at build time.
FROM node:24-alpine AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

# Runtime dependencies are resolved separately rather than carried over from the
# build stage. This application declares exactly one -- `pg` -- so the difference
# is the whole TypeScript toolchain.
FROM node:24-alpine AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-alpine
WORKDIR /app
RUN addgroup -g 10001 -S parallax && adduser -u 10001 -S -G parallax parallax

COPY --from=deps  --chown=parallax:parallax /app/node_modules ./node_modules
COPY --from=build --chown=parallax:parallax /app/dist ./dist
COPY --chown=parallax:parallax package.json ./
# The portal's assets. `findPublicDirectory()` walks up from the entry point's
# own directory, so `/app/dist/src` reaches `/app/public` on its second step.
COPY --chown=parallax:parallax public ./public
# Never read at runtime. They are here so an operator applying them with psql can
# check the schema against the image that will run on it.
COPY --chown=parallax:parallax migrations ./migrations

# Every operation is available from the command line, so it gets a name on PATH
# rather than making an operator remember the path into dist.
RUN printf '#!/bin/sh\nexec node /app/dist/cmd/parallax/main.js "$@"\n' > /usr/local/bin/parallax \
 && chmod 0755 /usr/local/bin/parallax

# With DATABASE_URL set nothing here is touched. Without it the file backend is
# used, and its default paths are relative -- which would put state inside the
# application directory and fail, because that directory is deliberately not
# writable by the user this runs as. A dedicated directory is the mount point.
#
# Deliberately not a VOLUME. Kubernetes ignores the instruction, so it buys
# nothing where this actually runs; Docker honours it by creating an anonymous
# volume, which silently defeats `--read-only` and accumulates volumes on any
# host that runs the image. Mount something writable here only if the file
# backend is in use -- an emptyDir is enough, because nothing written here is
# authoritative while PostgreSQL is the store.
RUN mkdir -p /var/lib/parallax && chown parallax:parallax /var/lib/parallax
ENV PARALLAX_STATE_FILE=/var/lib/parallax/parallax-state.json
ENV PARALLAX_CONFIG_FILE=/var/lib/parallax/parallax-config.json
ENV PARALLAX_PROVIDER_STATE_FILE=/var/lib/parallax/provider-state.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# Numeric, because `runAsNonRoot` verifies the UID and cannot resolve a name.
USER 10001:10001

# No `--env-file-if-exists` here, unlike `pnpm start`: a container takes its
# configuration from the environment, and the flag announces the missing file on
# stderr at every boot, which would be the first line of every pod's log.
#
# Binding a non-loopback address with no access token is refused at startup, and
# this image binds 0.0.0.0 -- so PARALLAX_AUTH_TOKENS must be supplied. See the
# README's environment table for the value's shape.
CMD ["node", "dist/src/index.js"]
