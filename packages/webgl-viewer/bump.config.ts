import { defineConfig } from 'nbump'

export default defineConfig({
  publish: true,
  tag: false,
  commit: true,
  // eslint-disable-next-line no-template-curly-in-string
  commitMessage: 'chore(webgl-viewer): bump version ${NEW_VERSION}',
})
