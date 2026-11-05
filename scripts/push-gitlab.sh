#!/usr/bin/env bash
# 把 main 推到公司 GitLab（远端 gitlab）的 main。
#
# GitHub 上用个人邮箱，GitLab 的推送规则要求提交邮箱是 @shoplazza.com：这里把 main 复制一份、
# 只改写个人邮箱后推过去，本地 main 和 GitHub 不动。改写不改时间、内容和说明，同一个提交每次
# 改写出来的哈希都一样，所以 GitLab 那边总是快进推送；只有 GitHub 的 main 本身被改写过才需要 --force。
#
#   bash scripts/push-gitlab.sh            # 推 main
#   bash scripts/push-gitlab.sh --force    # GitHub 历史改写过之后用
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FROM_EMAIL="${PERSONAL_EMAIL:-xiangly203@outlook.com}"
TO_EMAIL="${WORK_EMAIL:-xiangyi@shoplazza.com}"
TMP="push-gitlab-tmp"
FORCE=""
[ "${1:-}" = "--force" ] && FORCE="--force"

cleanup() {
	git branch -D "$TMP" >/dev/null 2>&1 || true
	git update-ref -d "refs/original/refs/heads/$TMP" 2>/dev/null || true
}
trap cleanup EXIT

cleanup
git branch "$TMP" main
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter "
	[ \"\$GIT_AUTHOR_EMAIL\" = '$FROM_EMAIL' ] && export GIT_AUTHOR_EMAIL='$TO_EMAIL'
	[ \"\$GIT_COMMITTER_EMAIL\" = '$FROM_EMAIL' ] && export GIT_COMMITTER_EMAIL='$TO_EMAIL'
	true
" -- "$TMP" >/dev/null

left=$(git log --format='%ae%n%ce' "$TMP" | grep -vc "@shoplazza\.com$" || true)
if [ "$left" != "0" ]; then
	echo "还有 $left 处邮箱不是 @shoplazza.com，GitLab 会拒收：" >&2
	git log --format='%h %ae %ce %s' "$TMP" | grep -v "@shoplazza\.com [^ ]*@shoplazza\.com " >&2
	exit 1
fi

git push $FORCE gitlab "$TMP:refs/heads/main"
echo "已推到 gitlab main：$(git rev-parse --short "$TMP")（对应本地 main $(git rev-parse --short main)）"
