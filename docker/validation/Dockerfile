FROM node:20-bookworm AS node

FROM docker:27-cli AS docker-cli

FROM golang:1.24-bookworm

COPY --from=node /usr/local/ /usr/local/
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

ENV CI=true
ENV PATH="/usr/local/go/bin:${PATH}"

CMD ["bash"]
