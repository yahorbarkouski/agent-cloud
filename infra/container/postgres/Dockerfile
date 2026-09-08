FROM postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0
# The official image already configures PGDG's signed package repository.
RUN apt-get update -qq \
 && cd /tmp \
 && apt-get download pgbackrest=2.59.1-1.pgdg12+1 \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) checksum=ecea2337fe53ec1f86d87db21ad46747c7ff898bd877288452b90374e80a6fb9 ;; \
      arm64) checksum=992f0b8121c8d7f8af98130563f797eb413c7b0de049c50c3c7e516941ae2ff0 ;; \
      *) exit 1 ;; \
    esac \
 && echo "$checksum  pgbackrest_2.59.1-1.pgdg12+1_${arch}.deb" | sha256sum --check - \
 && apt-get install -y --no-install-recommends ./pgbackrest_2.59.1-1.pgdg12+1_${arch}.deb \
 && command -v flock \
 && test "$(pgbackrest version)" = 'pgBackRest 2.59.1' \
 && rm -rf /var/lib/apt/lists/* /tmp/pgbackrest_*.deb \
 && install -d -m 0700 -o postgres -g postgres /var/lib/pgbackrest /etc/pgbackrest \
 && install -d -m 0700 -o postgres -g postgres /var/spool/pgbackrest
COPY apps/control/assets/pgbackrest.conf /usr/local/share/control-pgbackrest.template
COPY --chmod=0755 infra/container/postgres/entrypoint.sh /usr/local/bin/control-postgres
ENTRYPOINT ["control-postgres"]
CMD ["postgres"]
