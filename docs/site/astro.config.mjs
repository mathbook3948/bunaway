import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    starlight({
      title: "bunaway",
      description: "웹 UI와 Bun 앱 백엔드를 연결하는 bunaway 개발 가이드",
      defaultLocale: "root",
      locales: { root: { label: "한국어", lang: "ko" } },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/mathbook3948/bunaway" },
      ],
      editLink: { baseUrl: "https://github.com/mathbook3948/bunaway/edit/main/docs/site/" },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "시작하기",
          items: [
            { label: "bunaway 이해하기", slug: "start/overview" },
            { label: "개발 환경 준비", slug: "start/prerequisites" },
            { label: "첫 앱 실행하기", slug: "start/quickstart" },
          ],
        },
        {
          label: "구조 이해하기",
          items: [
            { label: "프로젝트 파일", slug: "concepts/project-layout" },
            { label: "창과 뷰의 정책", slug: "concepts/views-and-policy" },
          ],
        },
        {
          label: "앱 만들기",
          items: [
            { label: "설치와 업데이트", slug: "guides/installation-and-upgrades" },
            { label: "프런트엔드 연결", slug: "guides/frontend" },
            { label: "명령과 이벤트", slug: "guides/commands-and-events" },
            { label: "타입과 스키마", slug: "guides/types-and-validation" },
            { label: "저장소와 앱 상태", slug: "guides/storage-and-state" },
            { label: "취소와 오류 처리", slug: "guides/cancellation-and-errors" },
            { label: "세션과 앱 수명", slug: "guides/sessions-and-lifecycle" },
            { label: "플러그인", slug: "guides/plugins" },
            { label: "Vite와 개발 흐름", slug: "guides/development" },
            { label: "빌드와 패키징", slug: "guides/build-and-package" },
          ],
        },
        {
          label: "레퍼런스",
          items: [
            { label: "API 찾아보기", slug: "reference/api" },
            { label: "bunaway.json", slug: "reference/configuration" },
            { label: "policy.json", slug: "reference/policy" },
            {
              label: "Client SDK",
              collapsed: true,
              items: [
                { slug: "reference/client/create-client" },
                { slug: "reference/client/invoke" },
                { slug: "reference/client/listen" },
                { slug: "reference/client/capabilities" },
                { slug: "reference/client/close" },
              ],
            },
            {
              label: "Backend SDK",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/backend" } }],
            },
            {
              label: "Host API",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/host" } }],
            },
            {
              label: "CLI",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/cli" } }],
            },
            {
              label: "패키징",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/packaging" } }],
            },
            { label: "스키마와 타입", slug: "reference/schema" },
            { label: "오류와 실행 제한", slug: "reference/errors" },
            { label: "지원 범위", slug: "reference/platforms" },
            { label: "문제 해결", slug: "reference/troubleshooting" },
          ],
        },
        {
          label: "프레임워크 기여",
          collapsed: true,
          items: [
            { label: "기여 자료", slug: "reference/design" },
            { label: "메시지와 프로세스 IPC", slug: "reference/protocol" },
            { label: "Windows 창과 뷰 구현", slug: "guides/multiple-views" },
            { label: "사용자 정의 클라이언트와 Transport", slug: "reference/client/transport" },
            {
              label: "도구와 런타임 API",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/tooling" } }],
            },
            { label: "문서 범위와 누락 검사", slug: "reference/coverage" },
          ],
        },
      ],
    }),
  ],
  vite: {
    resolve: { alias: { "@repo": fileURLToPath(new URL("../../", import.meta.url)) } },
  },
});
