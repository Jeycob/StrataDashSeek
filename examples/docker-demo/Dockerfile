FROM busybox:1.37.0
COPY index.html /www/index.html
COPY smoke.sh /smoke.sh
USER 65532:65532
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
