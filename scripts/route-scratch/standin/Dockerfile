FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
RUN useradd --system --uid 10001 gateway
COPY standin.py /opt/standin.py
USER gateway
EXPOSE 1080 8080
CMD ["python3", "-u", "/opt/standin.py"]
