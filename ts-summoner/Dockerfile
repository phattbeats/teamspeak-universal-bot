FROM node:22-alpine
RUN apk add --no-cache openssh-client sshpass tzdata
WORKDIR /app
COPY summoner.mjs /app/summoner.mjs
CMD ["node", "/app/summoner.mjs"]
