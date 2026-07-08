#!/usr/bin/env bash
# Dave Checklist 원클릭 배포 스크립트
# 하는 일: 빌드 -> Firebase Hosting 배포 -> git 커밋 & 푸시
# 사용법:
#   ./deploy.sh                 (기본 커밋 메시지: "deploy: <시각>")
#   ./deploy.sh "커밋 메시지"    (직접 메시지 지정)

# nvm/node 로드 (이 스크립트를 어디서 실행하든 node를 잡을 수 있게)
# 주의: nvm.sh는 미설정 변수를 참조하므로 `set -u` 켜기 전에 먼저 로드한다.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use --lts >/dev/null 2>&1 || true

# nvm 로드 후 strict 모드 활성화 (-u 제외: nvm 잔여 영향 방지)
set -eo pipefail

# 스크립트가 위치한 폴더로 이동 (= 프로젝트 루트)
cd "$(dirname "$0")"

MSG="${1:-deploy: $(date '+%Y-%m-%d %H:%M:%S')}"

echo "==> 1/3 빌드 (npm run build)"
npm run build

echo "==> 2/3 Firebase Hosting 배포"
npx firebase-tools deploy --only hosting

echo "==> 3/3 git 커밋 & 푸시"
git add -A
if git diff --cached --quiet; then
  echo "    변경 사항 없음 → 커밋 건너뜀"
else
  git commit -m "$MSG"
  git push
  echo "    푸시 완료"
fi

echo ""
echo "✅ 배포 완료: https://dave-checklist.web.app"
