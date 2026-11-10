# Редактор — статический сайт: nginx отдаёт index.html, js, css, example.osm
# и проксирует /checker/ на сервер проверки (адрес — переменная CHECKER_URL)
FROM nginx:1.27-alpine
ENV CHECKER_URL=http://innerlogistics.lovethosetrains.com:7078
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY index.html example.osm /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY vendor /usr/share/nginx/html/vendor
EXPOSE 80
