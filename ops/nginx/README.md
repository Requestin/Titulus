# Nginx site configs for Titulus deployments.

## graphics.gyhyry.com

Dev stack ports (see `dev-start.sh` at repo root):

| Service   | Port  |
|-----------|-------|
| Frontend  | 3011  |
| Backend   | 3002  |

Deploy after editing:

```bash
sudo cp ops/nginx/graphics.gyhyry.com.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/graphics.gyhyry.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then start the app: `./dev-start.sh` from the repo root.
