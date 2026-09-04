FROM ghcr.io/searxng/searxng:latest

COPY settings.yml /opt/chatter/search-settings.yml

# The upstream image exposes /etc/searxng as a volume. Keep Chatter's bundled
# configuration outside it so recreating the container cannot retain an older
# settings.yml from an anonymous volume.
ENV SEARXNG_SETTINGS_PATH=/opt/chatter/search-settings.yml
