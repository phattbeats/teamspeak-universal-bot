FROM node:22-alpine
RUN apk add --no-cache openssh-client sshpass tzdata
WORKDIR /app
COPY summoner.mjs schedule.mjs story.mjs variety.mjs guests.mjs /app/
# Defaults; deploy.sh mounts the live, editable copies over these.
COPY live/ /app/live/
CMD ["node", "/app/summoner.mjs"]
