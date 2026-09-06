FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
RUN apk add --no-cache openssh-server=10.2_p1-r0 && adduser -D agent-probe && passwd -d agent-probe
COPY sshd_config /etc/ssh/sshd_config
COPY guestctl /usr/local/bin/guestctl
COPY entrypoint /usr/local/bin/start-fixture
RUN chmod 755 /usr/local/bin/guestctl /usr/local/bin/start-fixture
ENTRYPOINT ["/usr/local/bin/start-fixture"]
