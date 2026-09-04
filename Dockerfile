# 使用轻量级 Nginx Alpine 基础镜像
FROM nginx:alpine

# 复制自定义 Nginx 配置文件
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 复制前端网页资源至 Nginx 静态托管目录
COPY . /usr/share/nginx/html

# 暴露 80 端口
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
