import { ViewPlugin } from '@remixproject/engine-web'

import * as packageJson from '../../../../../package.json'
import React from 'react' // eslint-disable-line
import ReactDOM from 'react-dom'
import { Workspace } from '@remix-ui/workspace' // eslint-disable-line
import ethutil from 'ethereumjs-util'
var EventManager = require('../../lib/events')
var { RemixdHandle } = require('../files/remixd-handle.js')
var { GitHandle } = require('../files/git-handle.js')
var globalRegistry = require('../../global/registry')
var examples = require('../editor/examples')
var GistHandler = require('../../lib/gist-handler')
var QueryParams = require('../../lib/query-params')

/*
  Overview of APIs:
   * fileManager: @args fileProviders (browser, shared-folder, swarm, github, etc ...) & config & editor
      - listen on browser & localhost file provider (`fileRenamed` & `fileRemoved`)
      - update the tabs, switchFile
      - trigger `currentFileChanged`
      - set the current file in the config
   * fileProvider: currently browser, swarm, localhost, github, gist
      - link to backend
      - provide properties `type`, `readonly`
      - provide API `resolveDirectory`, `remove`, `exists`, `rename`, `get`, `set`
      - trigger `fileExternallyChanged`, `fileRemoved`, `fileRenamed`, `fileRenamedError`, `fileAdded`
   * file-explorer: treeview @args fileProvider
      - listen on events triggered by fileProvider
      - call fileProvider API
*/

const profile = {
  name: 'fileExplorers',
  displayName: 'File explorers',
  methods: ['createNewFile', 'uploadFile', 'getCurrentWorkspace', 'getWorkspaces', 'createWorkspace'],
  events: ['setWorkspace', 'renameWorkspace', 'deleteWorkspace'],
  icon: 'assets/img/fileManager.webp',
  description: ' - ',
  kind: 'fileexplorer',
  location: 'sidePanel',
  documentation: 'https://remix-ide.readthedocs.io/en/latest/file_explorer.html',
  version: packageJson.version
}

module.exports = class Filepanel extends ViewPlugin {
  constructor (appManager) {
    super(profile)
    this.event = new EventManager()
    this._components = {}
    this._components.registry = globalRegistry
    this._deps = {
      fileProviders: this._components.registry.get('fileproviders').api,
      fileManager: this._components.registry.get('filemanager').api
    }

    this.el = document.createElement('div')
    this.el.setAttribute('id', 'fileExplorerView')

    this.remixdHandle = new RemixdHandle(this.remixdExplorer, this._deps.fileProviders.localhost, appManager)
    this.gitHandle = new GitHandle()
    this.registeredMenuItems = []
    this.request = {}
    this.workspaces = []
    this.initWorkspace()
  }

  render () {
    return this.el
  }

  renderComponent () {
    ReactDOM.render(
      <Workspace
        createWorkspace={this.createWorkspace.bind(this)}
        setWorkspace={this.setWorkspace.bind(this)}
        workspaceRenamed={this.workspaceRenamed.bind(this)}
        workspaceDeleted={this.workspaceDeleted.bind(this)}
        workspaceCreated={this.workspaceCreated.bind(this)}
        workspace={this._deps.fileProviders.workspace}
        browser={this._deps.fileProviders.browser}
        localhost={this._deps.fileProviders.localhost}
        fileManager={this._deps.fileManager}
        registry={this._components.registry}
        plugin={this}
        request={this.request}
        examples={examples}
        workspaces={this.workspaces}
        registeredMenuItems={this.registeredMenuItems}
      />
      , this.el)
  }

  /**
   * @param item { id: string, name: string, type?: string[], path?: string[], extension?: string[], pattern?: string[] }
   * @param callback (...args) => void
   */
  registerContextMenuItem (item) {
    if (!item) throw new Error('Invalid register context menu argument')
    if (!item.name || !item.id) throw new Error('Item name and id is mandatory')
    if (!item.type && !item.path && !item.extension && !item.pattern) throw new Error('Invalid file matching criteria provided')

    this.registeredMenuItems = [...this.registeredMenuItems, item]
    this.renderComponent()
  }

  async getCurrentWorkspace () {
    return await this.request.getWorkspaces()
  }

  async getWorkspaces () {
    const result = new Promise((resolve, reject) => {
      const workspacesPath = this._deps.fileProviders.workspace.workspacesPath

      this._deps.fileProviders.browser.resolveDirectory('/' + workspacesPath, (error, items) => {
        if (error) {
          console.error(error)
          return reject(error)
        }
        resolve(Object.keys(items)
          .filter((item) => items[item].isDirectory)
          .map((folder) => folder.replace(workspacesPath + '/', '')))
      })
    })
    this.workspaces = await result
    this.renderComponent()
    return this.workspaces
  }

  async initWorkspace () {
    const queryParams = new QueryParams()
    const gistHandler = new GistHandler()
    const workspacesPath = this._deps.fileProviders.workspace.workspacesPath
    const params = queryParams.get()
    // get the file from gist
    const loadedFromGist = gistHandler.loadFromGist(params, this._deps.fileManager)

    if (loadedFromGist) return
    if (params.code) {
      try {
        await this._deps.fileManager.createWorkspace('code-sample')
        var hash = ethutil.bufferToHex(ethutil.keccak(params.code))
        const fileName = 'contract-' + hash.replace('0x', '').substring(0, 10) + '.sol'
        const path = 'browser/' + workspacesPath + '/code-sample/' + fileName
        await this._deps.fileManager.writeFile(path, atob(params.code))
        this.setWorkspace({ name: 'code-sample', isLocalhost: false })
        await this._deps.fileManager.openFile(path)
      } catch (e) {
        console.error(e)
      }
      return
    }
    // insert example contracts if there are no files to show
    this._deps.fileProviders.browser.resolveDirectory('/', async (error, filesList) => {
      if (error) console.error(error)
      if (Object.keys(filesList).length === 0) {
        await this.createWorkspace('default_workspace')
      }
      this.getWorkspaces()
    })
  }

  async createNewFile () {
    return await this.request.createNewFile()
  }

  async uploadFile () {
    return await this.request.uploadFile()
  }

  async createWorkspace (workspaceName) {
    if (await this._deps.fileManager.workspaceExists(workspaceName)) throw new Error('workspace already exists')
    const workspacesPath = this._deps.fileProviders.workspace.workspacesPath
    await this._deps.fileManager.createWorkspace(workspaceName)
    for (const file in examples) {
      try {
        await this._deps.fileManager.writeFile('browser/' + workspacesPath + '/' + workspaceName + '/' + examples[file].name, examples[file].content)
      } catch (error) {
        console.error(error)
      }
    }
  }

  /** these are called by the react component, action is already finished whent it's called */
  async setWorkspace (workspace) {
    this._deps.fileManager.removeTabsOf(this._deps.fileProviders.workspace)
    if (workspace.isLocalhost) {
      this.call('manager', 'activatePlugin', 'remixd')
    } else if (await this.call('manager', 'isActive', 'remixd')) {
      this.call('manager', 'deactivatePlugin', 'remixd')
    }
    this.emit('setWorkspace', workspace)
  }

  workspaceRenamed (workspace) {
    this.emit('renameWorkspace', workspace)
  }

  workspaceDeleted (workspace) {
    this.emit('deleteWorkspace', workspace)
  }

  workspaceCreated (workspace) {
    this.emit('createWorkspace', workspace)
  }
  /** end section */
}
