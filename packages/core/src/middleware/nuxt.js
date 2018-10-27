import generateETag from 'etag'
import fresh from 'fresh'
import consola from 'consola'

import { getContext } from '@nuxt/common'

export default async function nuxtMiddleware(req, res, next) {
  // Get context
  const context = getContext(req, res)

  res.statusCode = 200
  try {
    const result = await this.renderRoute(req.url, context)
    await this.nuxt.callHook('render:route', req.url, result, context)
    const {
      html,
      cspScriptSrcHashSet,
      error,
      redirected,
      getPreloadFiles
    } = result

    if (redirected) {
      this.nuxt.callHook('render:routeDone', req.url, result, context)
      return html
    }
    if (error) {
      res.statusCode = context.nuxt.error.statusCode || 500
    }

    // Add ETag header
    if (!error && this.options.render.etag) {
      const etag = generateETag(html, this.options.render.etag)
      if (fresh(req.headers, { etag })) {
        res.statusCode = 304
        res.end()
        this.nuxt.callHook('render:routeDone', req.url, result, context)
        return
      }
      res.setHeader('ETag', etag)
    }

    // HTTP2 push headers for preload assets
    if (!error && this.options.render.http2.push) {
      // Parse resourceHints to extract HTTP.2 prefetch/push headers
      // https://w3c.github.io/preload/#server-push-http-2
      const preloadFiles = getPreloadFiles()
      const { shouldPush, pushAssets } = this.options.render.http2
      const { publicPath } = this.resources.clientManifest

      const links = pushAssets ? pushAssets(req, res, publicPath, preloadFiles) : defaultPushAssets(preloadFiles, shouldPush, publicPath, this.options.dev)

      // Pass with single Link header
      // https://blog.cloudflare.com/http-2-server-push-with-multiple-assets-per-link-header
      // https://www.w3.org/Protocols/9707-link-header.html
      if (links.length > 0) {
        res.setHeader('Link', links.join(', '))
      }
    }

    if (this.options.render.csp) {
      const { allowedSources, policies } = this.options.render.csp
      const cspHeader = this.options.render.csp.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'

      res.setHeader(cspHeader, getCspString({ cspScriptSrcHashSet, allowedSources, policies, isDev: this.options.dev }))
    }

    // Send response
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Length', Buffer.byteLength(html))
    res.end(html, 'utf8')
    this.nuxt.callHook('render:routeDone', req.url, result, context)
    return html
  } catch (err) {
    /* istanbul ignore if */
    if (context && context.redirected) {
      consola.error(err)
      return err
    }

    next(err)
  }
}

const defaultPushAssets = (preloadFiles, shouldPush, publicPath, isDev) => {
  if (shouldPush && isDev) {
    consola.warn('http2.shouldPush is deprecated. User http2.pushAssets function')
  }

  const links = []
  preloadFiles.forEach(({ file, asType, fileWithoutQuery }) => {
    // By default, we only preload scripts or css
    /* istanbul ignore if */
    if (!shouldPush && asType !== 'script' && asType !== 'style') {
      return
    }

    // User wants to explicitly control what to preload
    if (shouldPush && !shouldPush(fileWithoutQuery, asType)) {
      return
    }

    links.push(`<${publicPath}${file}>; rel=preload; as=${asType}`)
  })
  return links
}

const getCspString = ({ cspScriptSrcHashSet, allowedSources, policies, isDev }) => {
  const joinedHashSet = Array.from(cspScriptSrcHashSet).join(' ')
  const baseCspStr = `script-src 'self'${isDev ? ` 'unsafe-eval'` : ''} ${joinedHashSet}`

  if (Array.isArray(allowedSources)) {
    return `${baseCspStr} ${allowedSources.join(' ')}`
  }

  const policyObjectAvailable = typeof policies === 'object' && policies !== null && !Array.isArray(policies)

  if (policyObjectAvailable) {
    const transformedPolicyObject = transformPolicyObject(policies, cspScriptSrcHashSet)

    return Object.entries(transformedPolicyObject).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')
  }

  return baseCspStr
}

const transformPolicyObject = (policies, cspScriptSrcHashSet) => {
  const userHasDefinedScriptSrc = policies['script-src'] && Array.isArray(policies['script-src'])

  // Self is always needed for inline-scripts, so add it, no matter if the user specified script-src himself.

  const hashAndPolicySet = cspScriptSrcHashSet
  hashAndPolicySet.add(`'self'`)

  if (!userHasDefinedScriptSrc) {
    policies['script-src'] = Array.from(hashAndPolicySet)
    return policies
  }

  new Set(policies['script-src']).forEach(src => hashAndPolicySet.add(src))

  policies['script-src'] = Array.from(hashAndPolicySet)

  return policies
}