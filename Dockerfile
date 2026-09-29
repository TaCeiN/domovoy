# ── финальный образ ───────────────────────────────────────────────
#
# Стадии сборки нет: Node 22+ выполняет TypeScript напрямую, бандлить
# нечего. Раньше здесь стояла стадия `deps` с полным `npm ci` — её
# результат в финальный образ не копировался ни разу, то есть все
# зависимости, включая typescript и esbuild, ставились впустую.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Часовой пояс: окно приёма показаний (20–25 число) и текущий период
# считаются по локальному времени процесса. В alpine это UTC, а жители
# в UTC+3 — в ночь на первое число показания уезжали в прошлый месяц.
ENV TZ=Europe/Moscow
RUN apk add --no-cache tzdata

# Корневой сертификат Минцифры: домен platform-api2.max.ru подписан им,
# и без этого сертификата вызовы Bot API падают на UNABLE_TO_GET_ISSUER_CERT.
# Файл кладётся в certs/ рядом с Dockerfile — если его нет, шаг пропускается.
COPY cert[s]/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>/dev/null || true

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY lib ./lib
COPY db ./db
COPY public ./public
# Документация API — её отдаёт сервер (server/routes/docs.ts)
COPY openapi.yaml DATA-API.yaml API-TEST-DATA.json ./

# Node 22+ выполняет TypeScript напрямую — сборка не нужна,
# в отличие от serverless-платформ, под которые пришлось бы бандлить
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
# Каталог вложений — ВЛАДЕЛЕЦ app, а не root. Пустой том Docker при первом
# подключении берёт права из образа; без этой строки том domovoy_uploads
# создался с root, и приложение не могло сохранить ни одну фотографию
# жителя: EACCES на mkdir (найдено 26.09.2026, сидом демо-дома).
RUN mkdir -p /data/uploads && chown app:app /data/uploads
USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.ts"]
