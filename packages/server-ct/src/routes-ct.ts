import Debug from 'debug'
import { ErrorRequestHandler, Express } from 'express'
import httpProxy from 'http-proxy'
import send from 'send'
import { NetworkProxy } from '@packages/proxy'
import { handle, serve, serveChunk } from './runner-ct'
import xhrs from '@packages/server/lib/controllers/xhrs'
import { SpecsStore } from '@packages/server/lib/specs-store'
import { Cfg } from '@packages/server/lib/project-base'
import { getPathToDist } from '@packages/resolve-dist'
import { Browser } from '@packages/server/lib/browsers/types'

const debug = Debug('cypress:server:routes')

export interface InitializeRoutes {
  app: Express
  specsStore: SpecsStore
  config: Cfg
  getSpec: () => Cypress.Cypress['spec'] | null
  getCurrentBrowser: () => Browser
  nodeProxy: httpProxy
  networkProxy: NetworkProxy
  getRemoteState: () => any
  onError: (...args: unknown[]) => any
}

export const createRoutes = ({
  app,
  config,
  specsStore,
  nodeProxy,
  networkProxy,
  getCurrentBrowser,
  getSpec,
}: InitializeRoutes) => {
  app.get('/__cypress/runner/*', handle)

  app.get('/__cypress/static/*', (req, res) => {
    const pathToFile = getPathToDist('static', req.params[0])

    return send(req, pathToFile)
    .pipe(res)
  })

  app.get('/__cypress/iframes/*', (req, res) => {
    // always proxy to the index.html file
    // attach header data for webservers
    // to properly intercept and serve assets from the correct src root
    // TODO: define a contract for dev-server plugins to configure this behavior
    req.headers.__cypress_spec_path = req.params[0]
    req.url = `${config.devServerPublicPathRoute}/index.html`

    // user the node proxy here instead of the network proxy
    // to avoid the user accidentally intercepting and modifying
    // our internal index.html handler

    nodeProxy.web(req, res, {}, (e) => {
      if (e) {
        // eslint-disable-next-line
        debug('Proxy request error. This is likely the socket hangup issue, we can basically ignore this because the stream will automatically continue once the asset will be available', e)
      }
    })
  })

  // user app code + spec code
  // default mounted to /__cypress/src/*
  app.get(`${config.devServerPublicPathRoute}*`, (req, res) => {
    // user the node proxy here instead of the network proxy
    // to avoid the user accidentally intercepting and modifying
    // their own app.js files + spec.js files
    nodeProxy.web(req, res, {}, (e) => {
      if (e) {
        // eslint-disable-next-line
        debug('Proxy request error. This is likely the socket hangup issue, we can basically ignore this because the stream will automatically continue once the asset will be available', e)
      }
    })
  })

  const clientRoute = config.clientRoute

  if (!clientRoute) {
    throw Error(`clientRoute is required. Received ${clientRoute}`)
  }

  app.all('/__cypress/xhrs/*', (req, res, next) => {
    xhrs.handle(req, res, config, next)
  })

  app.get(clientRoute, (req, res) => {
    debug('Serving Cypress front-end by requested URL:', req.url)

    serve(req, res, {
      config,
      getCurrentBrowser,
      specsStore,
    })
  })

  // enables runner-ct to make a dynamic import
  app.get(`${clientRoute}ctChunk-*`, (req, res) => {
    debug('Serving Cypress front-end chunk by requested URL:', req.url)

    serveChunk(req, res, { config })
  })

  app.get(`${clientRoute}vendors~ctChunk-*`, (req, res) => {
    debug('Serving Cypress front-end vendor chunk by requested URL:', req.url)

    serveChunk(req, res, { config })
  })

  app.all('*', (req, res) => {
    networkProxy.handleHttpRequest(req, res)
  })

  // when we experience uncaught errors
  // during routing just log them out to
  // the console and send 500 status
  // and report to raygun (in production)
  const errorHandlingMiddleware: ErrorRequestHandler = (err, req, res) => {
    console.log(err.stack) // eslint-disable-line no-console

    res.set('x-cypress-error', err.message)
    res.set('x-cypress-stack', JSON.stringify(err.stack))

    res.sendStatus(500)
  }

  app.use(errorHandlingMiddleware)
}
