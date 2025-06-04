set -e
pnpm --filter=@photo-gallery/web run build:manifest

cd apps/web/assets-git

echo "git add ."
git add . || true
echo "git commit -m 'chore: update photos-manifest.json and thumbnails'"
git commit -m "chore: update photos-manifest.json and thumbnails" || true
echo "git push"
git push || true

echo "done"
