import { bns } from 'biggystring'
import type { EdgeTransaction } from 'edge-core-js/src/types/types'

import {
  asyncWaterfall,
  isHex,
  pickRandom,
  promiseAny,
  shuffleArray,
  snooze,
  validateObject
} from '../common/utils'
import { EthereumEngine } from './ethEngine'
import { currencyInfo } from './ethInfo'
import {
  AlethioAccountsTokenTransferSchema,
  AlethioAccountsTxSchema,
  BlockChairAddressSchema,
  BlockChairStatsSchema,
  EtherscanGetAccountBalance,
  EtherscanGetAccountNonce,
  EtherscanGetBlockHeight,
  EtherscanGetTokenTransactions,
  EtherscanGetTransactions
} from './ethSchema'
import type {
  AlethioTokenTransfer,
  AlethioTransaction,
  EthereumTxOtherParams,
  EtherscanTransaction
} from './ethTypes'

const BLOCKHEIGHT_POLL_MILLISECONDS = 20000
const NONCE_POLL_MILLISECONDS = 20000
const BAL_POLL_MILLISECONDS = 20000
const TXS_POLL_MILLISECONDS = 20000

const ADDRESS_QUERY_LOOKBACK_BLOCKS = 4 * 2 // ~ 2 minutes
const NUM_TRANSACTIONS_TO_QUERY = 50
const PRIMARY_CURRENCY = currencyInfo.currencyCode

type EthereumNeeds = {
  blockHeightLastChecked: number,
  nonceLastChecked: number,
  tokenBalLastChecked: { [currencyCode: string]: number },
  tokenTxsLastChecked: { [currencyCode: string]: number }
}

type EdgeTransactionsBlockHeightTuple = {
  blockHeight: number,
  edgeTransactions: Array<EdgeTransaction>
}

type EthereumNetworkUpdate = {
  blockHeight?: number,
  nonce?: number,
  tokenBal?: { [currencyCode: string]: string },
  tokenTxs?: { [currencyCode: string]: EdgeTransactionsBlockHeightTuple },
  server: string
}

type EthFunction =
  | 'broadcastTx'
  | 'eth_blockNumber'
  | 'eth_getTransactionCount'
  | 'eth_getBalance'
  | 'eth_estimateGas'
  | 'getTokenBalance'
  | 'getTransactions'

type BroadcastResults = {
  incrementNonce: boolean,
  decrementNonce: boolean
}

async function broadcastWrapper(promise: Promise<Object>, server: string) {
  const out = {
    result: await promise,
    server
  }
  return out
}

export class EthereumNetwork {
  ethNeeds: EthereumNeeds
  constructor(ethEngine: EthereumEngine) {
    this.ethEngine = ethEngine
    this.ethNeeds = {
      blockHeightLastChecked: 0,
      nonceLastChecked: 0,
      tokenBalLastChecked: {},
      tokenTxsLastChecked: {}
    }

    this.fetchGetEtherscan = this.fetchGetEtherscan.bind(this)
    this.fetchPostInfura = this.fetchPostInfura.bind(this)
    this.multicastServers = this.multicastServers.bind(this)
    this.checkBlockHeightEthscan = this.checkBlockHeightEthscan.bind(this)
    this.checkBlockHeightBlockchair = this.checkBlockHeightBlockchair.bind(this)
    this.checkBlockHeight = this.checkBlockHeight.bind(this)
    this.checkNonce = this.checkNonce.bind(this)
    this.checkTxs = this.checkTxs.bind(this)
    this.checkTokenBalEthscan = this.checkTokenBalEthscan.bind(this)
    this.checkTokenBalBlockchair = this.checkTokenBalBlockchair.bind(this)
    this.checkTokenBal = this.checkTokenBal.bind(this)
    this.processEthereumNetworkUpdate = this.processEthereumNetworkUpdate.bind(
      this
    )
  }

  processEtherscanTransaction(tx: EtherscanTransaction, currencyCode: string) {
    let netNativeAmount: string // Amount received into wallet
    const ourReceiveAddresses: Array<string> = []
    let nativeNetworkFee: string

    if (tx.contractAddress) {
      nativeNetworkFee = '0'
    } else {
      nativeNetworkFee = bns.mul(tx.gasPrice, tx.gasUsed)
    }

    if (
      tx.from.toLowerCase() ===
      this.ethEngine.walletLocalData.publicKey.toLowerCase()
    ) {
      // is a spend
      if (tx.from.toLowerCase() === tx.to.toLowerCase()) {
        // Spend to self. netNativeAmount is just the fee
        netNativeAmount = bns.mul(nativeNetworkFee, '-1')
      } else {
        // spend to someone else
        netNativeAmount = bns.sub('0', tx.value)

        // For spends, include the network fee in the transaction amount
        netNativeAmount = bns.sub(netNativeAmount, nativeNetworkFee)
      }
    } else {
      // Receive transaction
      netNativeAmount = bns.add('0', tx.value)
      ourReceiveAddresses.push(
        this.ethEngine.walletLocalData.publicKey.toLowerCase()
      )
    }

    const otherParams: EthereumTxOtherParams = {
      from: [tx.from],
      to: [tx.to],
      gas: tx.gas,
      gasPrice: tx.gasPrice,
      gasUsed: tx.gasUsed,
      cumulativeGasUsed: tx.cumulativeGasUsed,
      errorVal: parseInt(tx.isError),
      tokenRecipientAddress: null
    }

    let blockHeight = parseInt(tx.blockNumber)
    if (blockHeight < 0) blockHeight = 0
    const edgeTransaction: EdgeTransaction = {
      txid: tx.hash,
      date: parseInt(tx.timeStamp),
      currencyCode,
      blockHeight,
      nativeAmount: netNativeAmount,
      networkFee: nativeNetworkFee,
      ourReceiveAddresses,
      signedTx: '',
      otherParams
    }

    return edgeTransaction
  }

  processAlethioTransaction(
    tokenTransfer: AlethioTokenTransfer,
    tx: AlethioTransaction,
    currencyCode: string
  ): EdgeTransaction | null {
    let netNativeAmount: string
    const ourReceiveAddresses: Array<string> = []
    let nativeNetworkFee: string
    let tokenRecipientAddress: string | null
    let parentNetworkFee: string

    const value = tx.attributes.value
    const fee = tx.attributes.fee
    const fromAddress = tokenTransfer.relationships.from.data.id
    const toAddress = tokenTransfer.relationships.to.data.id

    if (currencyCode === PRIMARY_CURRENCY) {
      nativeNetworkFee = fee
      tokenRecipientAddress = null
      parentNetworkFee = ''
    } else {
      nativeNetworkFee = '0'
      tokenRecipientAddress = toAddress
      parentNetworkFee = fee
    }

    if (
      fromAddress.toLowerCase() ===
      this.ethEngine.walletLocalData.publicKey.toLowerCase()
    ) {
      // is a spend
      if (fromAddress.toLowerCase() === toAddress.toLowerCase()) {
        // Spend to self. netNativeAmount is just the fee
        netNativeAmount = bns.mul(nativeNetworkFee, '-1')
      } else {
        // spend to someone else
        netNativeAmount = bns.sub('0', value)

        // For spends, include the network fee in the transaction amount
        netNativeAmount = bns.sub(netNativeAmount, nativeNetworkFee)
      }
    } else if (
      toAddress.toLowerCase() ===
      this.ethEngine.walletLocalData.publicKey.toLowerCase()
    ) {
      // Receive transaction
      netNativeAmount = value
      ourReceiveAddresses.push(
        this.ethEngine.walletLocalData.publicKey.toLowerCase()
      )
    } else {
      return null
    }

    const otherParams: EthereumTxOtherParams = {
      from: [fromAddress],
      to: [toAddress],
      gas: tx.attributes.msgGasLimit,
      gasPrice: tx.attributes.txGasPrice,
      gasUsed: `${tx.attributes.txGasUsed}`,
      errorVal: tx.attributes.msgError ? 1 : 0,
      tokenRecipientAddress
    }

    let blockHeight = tokenTransfer.attributes.globalRank[0]
    if (blockHeight < 0) blockHeight = 0
    const edgeTransaction: EdgeTransaction = {
      txid: tx.attributes.txHash,
      date: tx.attributes.blockCreationTime,
      currencyCode,
      blockHeight,
      nativeAmount: netNativeAmount,
      networkFee: nativeNetworkFee,
      ourReceiveAddresses,
      signedTx: '',
      parentNetworkFee,
      otherParams
    }

    return edgeTransaction
  }

  async fetchGet(url: string, _options: Object = {}) {
    const options = { ..._options }
    options.method = 'GET'
    const response = await this.ethEngine.io.fetch(url, options)
    if (!response.ok) {
      const {
        blockcypherApiKey,
        etherscanApiKey,
        infuraProjectId,
        blockchairApiKey
      } = this.ethEngine.initOptions
      if (typeof etherscanApiKey === 'string')
        url = url.replace(etherscanApiKey, 'private')
      if (Array.isArray(etherscanApiKey)) {
        for (const key of etherscanApiKey) {
          url = url.replace(key, 'private')
        }
      }
      if (blockcypherApiKey) url = url.replace(blockcypherApiKey, 'private')
      if (infuraProjectId) url = url.replace(infuraProjectId, 'private')
      if (blockchairApiKey) url = url.replace(blockchairApiKey, 'private')
      throw new Error(
        `The server returned error code ${response.status} for ${url}`
      )
    }
    return response.json()
  }

  async fetchGetEtherscan(server: string, cmd: string) {
    const { etherscanApiKey } = this.ethEngine.initOptions
    const chosenKey = Array.isArray(etherscanApiKey)
      ? pickRandom(etherscanApiKey, 1)[0]
      : etherscanApiKey
    const apiKey =
      chosenKey && chosenKey.length > 5 && server.includes('etherscan')
        ? '&apikey=' + chosenKey
        : ''

    const url = `${server}/api${cmd}${apiKey}`
    return this.fetchGet(url)
  }

  async fetchPostInfura(method: string, params: Object) {
    const { infuraProjectId } = this.ethEngine.initOptions
    if (!infuraProjectId || infuraProjectId.length < 6) {
      throw new Error('Need Infura Project ID')
    }
    const url = `https://mainnet.infura.io/v3/${infuraProjectId}`
    const body = {
      id: 1,
      jsonrpc: '2.0',
      method,
      params
    }
    const response = await this.ethEngine.io.fetch(url, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      method: 'POST',
      body: JSON.stringify(body)
    })
    const jsonObj = await response.json()
    return jsonObj
  }

  async fetchPostBlockcypher(cmd: string, body: any) {
    const { blockcypherApiKey } = this.ethEngine.initOptions
    let apiKey = ''
    if (blockcypherApiKey && blockcypherApiKey.length > 5) {
      apiKey = '&token=' + blockcypherApiKey
    }
    const url = `${
      this.ethEngine.currencyInfo.defaultSettings.otherSettings
        .blockcypherApiServers[0]
    }/${cmd}${apiKey}`
    const response = await this.ethEngine.io.fetch(url, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      method: 'POST',
      body: JSON.stringify(body)
    })
    return response.json()
  }

  async fetchGetBlockchair(path: string, includeKey: boolean = false) {
    let keyParam = ''
    if (includeKey) {
      const { blockchairApiKey } = this.ethEngine.initOptions
      keyParam = `&key=${blockchairApiKey}`
    }
    const url = `${
      this.ethEngine.currencyInfo.defaultSettings.otherSettings
        .blockchairApiServers[0]
    }${path}${keyParam}`
    return this.fetchGet(url)
  }

  /*
   * @param pathOrLink: A "path" is appended to the alethioServers base URL and
   *  a "link" is a full URL that needs no further modification
   * @param isPath: If TRUE then the pathOrLink param is interpretted as a "path"
   *  otherwise it is interpretted as a "link"
   *
   * @throws Exception when Alethio throttles with a 429 response code
   */
  async fetchGetAlethio(pathOrLink: string, isPath: boolean = true) {
    console.log(`fetchGetAlethio: ${pathOrLink}`)
    const { alethioApiKey } = this.ethEngine.initOptions
    if (alethioApiKey) {
      const url = isPath
        ? `${
            this.ethEngine.currencyInfo.defaultSettings.otherSettings
              .alethioApiServers[0]
          }${pathOrLink}`
        : pathOrLink
      return this.fetchGet(url, {
        headers: {
          Authorization: `Bearer ${alethioApiKey}`
        }
      })
    } else {
      return Promise.reject(
        new Error('fetchGetAlethio ERROR: alethioApiKey not set')
      )
    }
  }

  async broadcastEtherscan(
    edgeTransaction: EdgeTransaction
  ): Promise<BroadcastResults> {
    const transactionParsed = JSON.stringify(edgeTransaction, null, 2)

    this.ethEngine.log(
      `Etherscan: sent transaction to network:\n${transactionParsed}\n`
    )
    const url = `?module=proxy&action=eth_sendRawTransaction&hex=${edgeTransaction.signedTx}`
    const jsonObj = await this.fetchGetEtherscan(
      this.ethEngine.currencyInfo.defaultSettings.otherSettings
        .etherscanApiServers[0],
      url
    )

    this.ethEngine.log('broadcastEtherscan jsonObj:', jsonObj)

    if (typeof jsonObj.error !== 'undefined') {
      this.ethEngine.log('EtherScan: Error sending transaction')
      throw jsonObj.error
    } else if (typeof jsonObj.result === 'string') {
      // Success!!
      return jsonObj
    } else {
      throw new Error('Invalid return value on transaction send')
    }
  }

  async broadcastInfura(
    edgeTransaction: EdgeTransaction
  ): Promise<BroadcastResults> {
    const transactionParsed = JSON.stringify(edgeTransaction, null, 2)

    const method = 'eth_sendRawTransaction'
    const params = [edgeTransaction.signedTx]

    const jsonObj = await this.fetchPostInfura(method, params)

    if (typeof jsonObj.error !== 'undefined') {
      this.ethEngine.log('EtherScan: Error sending transaction')
      throw jsonObj.error
    } else if (typeof jsonObj.result === 'string') {
      // Success!!
      this.ethEngine.log(
        `Infura: sent transaction to network:\n${transactionParsed}\n`
      )
      return jsonObj
    } else {
      throw new Error('Invalid return value on transaction send')
    }
  }

  async broadcastBlockCypher(
    edgeTransaction: EdgeTransaction
  ): Promise<BroadcastResults> {
    const transactionParsed = JSON.stringify(edgeTransaction, null, 2)
    this.ethEngine.log(
      `Blockcypher: sending transaction to network:\n${transactionParsed}\n`
    )

    const url = 'v1/eth/main/txs/push'
    const hexTx = edgeTransaction.signedTx.replace('0x', '')
    const jsonObj = await this.fetchPostBlockcypher(url, { tx: hexTx })

    this.ethEngine.log('broadcastBlockCypher jsonObj:', jsonObj)
    if (typeof jsonObj.error !== 'undefined') {
      this.ethEngine.log('BlockCypher: Error sending transaction')
      throw jsonObj.error
    } else if (jsonObj.tx && typeof jsonObj.tx.hash === 'string') {
      this.ethEngine.log(`Blockcypher success sending txid ${jsonObj.tx.hash}`)
      // Success!!
      return jsonObj
    } else {
      throw new Error('Invalid return value on transaction send')
    }
  }

  async multicastServers(func: EthFunction, ...params: any): Promise<any> {
    let out = { result: '', server: 'no server' }
    let funcs, funcs2, url
    switch (func) {
      case 'broadcastTx': {
        const promises = []
        promises.push(
          broadcastWrapper(this.broadcastInfura(params[0]), 'infura')
        )
        promises.push(
          broadcastWrapper(this.broadcastEtherscan(params[0]), 'etherscan')
        )
        promises.push(
          broadcastWrapper(this.broadcastBlockCypher(params[0]), 'blockcypher')
        )
        out = await promiseAny(promises)

        this.ethEngine.log(`ETH multicastServers ${func} ${out.server} won`)
        break
      }

      case 'eth_blockNumber':
        funcs = this.ethEngine.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            if (!server.includes('etherscan')) {
              throw new Error(
                `Unsupported command eth_blockNumber in ${server}`
              )
            }
            const result = await this.fetchGetEtherscan(
              server,
              '?module=proxy&action=eth_blockNumber'
            )
            if (typeof result.result !== 'string') {
              const msg = `Invalid return value eth_blockNumber in ${server}`
              this.ethEngine.log(msg)
              throw new Error(msg)
            }
            return { server, result }
          }
        )
        funcs2 = async () => {
          const result = await this.fetchPostInfura('eth_blockNumber', [])
          return { server: 'infura', result }
        }
        funcs.push(funcs2)
        // Randomize array
        funcs = shuffleArray(funcs)
        out = await asyncWaterfall(funcs)
        break

      case 'eth_estimateGas':
        funcs = []
        funcs2 = async () => {
          const result = await this.fetchPostInfura('eth_estimateGas', [
            params[0]
          ])
          return { server: 'infura', result }
        }
        funcs.push(funcs2)
        out = await asyncWaterfall(funcs)
        break

      case 'eth_getTransactionCount':
        url = `?module=proxy&action=eth_getTransactionCount&address=${
          params[0]
        }&tag=latest`
        funcs = this.ethEngine.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            if (!server.includes('etherscan')) {
              throw new Error(
                `Unsupported command eth_getTransactionCount in ${server}`
              )
            }
            const result = await this.fetchGetEtherscan(server, url)
            if (typeof result.result !== 'string') {
              const msg = `Invalid return value eth_getTransactionCount in ${server}`
              this.ethEngine.log(msg)
              throw new Error(msg)
            }
            return { server, result }
          }
        )
        funcs2 = async () => {
          const result = await this.fetchPostInfura('eth_getTransactionCount', [
            params[0],
            'latest'
          ])
          return { server: 'infura', result }
        }
        funcs.push(funcs2)
        // Randomize array
        funcs = shuffleArray(funcs)
        out = await asyncWaterfall(funcs)
        break
      case 'eth_getBalance':
        url = `?module=account&action=balance&address=${params[0]}&tag=latest`
        funcs = this.ethEngine.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            const result = await this.fetchGetEtherscan(server, url)
            if (!result.result || typeof result.result !== 'string') {
              const msg = `Invalid return value eth_getBalance in ${server}`
              this.ethEngine.log(msg)
              throw new Error(msg)
            }
            return { server, result }
          }
        )
        funcs2 = async () => {
          const result = await this.fetchPostInfura('eth_getBalance', [
            params[0],
            'latest'
          ])
          // Convert hex
          if (!isHex(result.result)) {
            throw new Error('Infura eth_getBalance not hex')
          }
          // Convert to decimal
          result.result = bns.add(result.result, '0')
          return { server: 'infura', result }
        }
        funcs.push(funcs2)
        // Randomize array
        funcs = shuffleArray(funcs)
        out = await asyncWaterfall(funcs)
        break
      case 'getTokenBalance':
        url = `?module=account&action=tokenbalance&contractaddress=${
          params[1]
        }&address=${params[0]}&tag=latest`
        funcs = this.ethEngine.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            const result = await this.fetchGetEtherscan(server, url)
            if (!result.result || typeof result.result !== 'string') {
              const msg = `Invalid return value getTokenBalance in ${server}`
              this.ethEngine.log(msg)
              throw new Error(msg)
            }
            return { server, result }
          }
        )
        // Randomize array
        funcs = shuffleArray(funcs)
        out = await asyncWaterfall(funcs)
        break
      case 'getTransactions': {
        const {
          currencyCode,
          address,
          startBlock,
          page,
          offset,
          contractAddress
        } = params[0]
        let startUrl
        if (currencyCode === 'ETH') {
          startUrl = `?action=txlist&module=account`
        } else {
          startUrl = `?action=tokentx&contractaddress=${contractAddress}&module=account`
        }
        url = `${startUrl}&address=${address}&startblock=${startBlock}&endblock=999999999&sort=asc&page=${page}&offset=${offset}`
        funcs = this.ethEngine.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            const result = await this.fetchGetEtherscan(server, url)
            if (
              typeof result.result !== 'object' ||
              typeof result.result.length !== 'number'
            ) {
              const msg = `Invalid return value getTransactions in ${server}`
              this.ethEngine.log(msg)
              throw new Error(msg)
            }
            return { server, result }
          }
        )
        // Randomize array
        funcs = shuffleArray(funcs)
        out = await asyncWaterfall(funcs)
        break
      }
    }

    return out
  }

  async checkBlockHeightEthscan(): Promise<EthereumNetworkUpdate> {
    const { result: jsonObj, server } = await this.multicastServers(
      'eth_blockNumber'
    )
    const valid = validateObject(jsonObj, EtherscanGetBlockHeight)
    if (valid) {
      const blockHeight = parseInt(jsonObj.result, 16)
      return { blockHeight, server }
    } else {
      throw new Error('Ethscan returned invalid JSON')
    }
  }

  async checkBlockHeightBlockchair(): Promise<EthereumNetworkUpdate> {
    const jsonObj = await this.fetchGetBlockchair('/ethereum/stats', false)
    const valid = validateObject(jsonObj, BlockChairStatsSchema)
    if (valid) {
      const blockHeight = parseInt(jsonObj.data.blocks, 10)
      return { blockHeight, server: 'blockchair' }
    } else {
      throw new Error('Blockchair returned invalid JSON')
    }
  }

  async checkBlockHeight(): Promise<EthereumNetworkUpdate> {
    return asyncWaterfall([
      this.checkBlockHeightEthscan,
      this.checkBlockHeightBlockchair
    ]).catch(err => {
      this.ethEngine.log('checkBlockHeight failed to update', err)
      return {}
    })
  }

  async checkNonce(): Promise<EthereumNetworkUpdate> {
    try {
      const address = this.ethEngine.walletLocalData.publicKey
      const { result: jsonObj, server } = await this.multicastServers(
        'eth_getTransactionCount',
        address
      )
      const valid = validateObject(jsonObj, EtherscanGetAccountNonce)
      if (valid) {
        const nonce = bns.add('0', jsonObj.result)
        return { nonce, server }
      }
    } catch (err) {
      this.ethEngine.log('Error fetching height: ' + err)
    }
    return {}
  }

  async checkTxsEthscan(
    startBlock: number,
    currencyCode: string
  ): Promise<EthereumNetworkUpdate> {
    const address = this.ethEngine.walletLocalData.publicKey
    let page = 1
    let contractAddress = ''
    let schema

    if (currencyCode === PRIMARY_CURRENCY) {
      schema = EtherscanGetTransactions
    } else {
      const tokenInfo = this.ethEngine.getTokenInfo(currencyCode)
      if (tokenInfo && typeof tokenInfo.contractAddress === 'string') {
        contractAddress = tokenInfo.contractAddress
        schema = EtherscanGetTokenTransactions
      } else {
        return {}
      }
    }

    const allTransactions = []
    let server
    while (1) {
      const offset = NUM_TRANSACTIONS_TO_QUERY
      const response = await this.multicastServers('getTransactions', {
        currencyCode,
        address,
        startBlock,
        page,
        offset,
        contractAddress
      })
      server = response.server
      const jsonObj = response.result
      const valid = validateObject(jsonObj, schema)
      if (valid) {
        const transactions = jsonObj.result
        for (let i = 0; i < transactions.length; i++) {
          const tx = this.processEtherscanTransaction(
            transactions[i],
            currencyCode
          )
          allTransactions.push(tx)
        }
        if (transactions.length < NUM_TRANSACTIONS_TO_QUERY) {
          break
        }
        page++
      } else {
        throw new Error(
          `checkTxsEthscan invalid JSON data:${JSON.stringify(jsonObj)}`
        )
      }
    }

    const edgeTransactionsBlockHeightTuple: EdgeTransactionsBlockHeightTuple = {
      blockHeight: startBlock,
      edgeTransactions: allTransactions
    }
    return {
      tokenTxs: { [currencyCode]: edgeTransactionsBlockHeightTuple },
      server
    }
  }

  /*
   * @returns The currencyCode of the token or undefined if
   * the token is not enabled for this user.
   */
  getTokenCurrencyCode(txnContractAddress: string): string | undefined {
    const address = this.ethEngine.walletLocalData.publicKey
    if (txnContractAddress.toLowerCase() === address.toLowerCase()) {
      return 'ETH'
    } else {
      for (const tk of this.ethEngine.walletLocalData.enabledTokens) {
        const tokenInfo = this.ethEngine.getTokenInfo(tk)
        if (tokenInfo) {
          const tokenContractAddress = tokenInfo.contractAddress
          if (
            txnContractAddress &&
            tokenContractAddress.toLowerCase() ===
              txnContractAddress.toLowerCase()
          ) {
            return tk
          }
        }
      }
    }
  }

  async checkTxsAlethio(
    startBlock: number,
    currencyCode: string
  ): Promise<EthereumNetworkUpdate> {
    const address = this.ethEngine.walletLocalData.publicKey

    let linkNext
    const allTransactions: Array<EdgeTransaction> = []
    while (1) {
      let jsonObj
      if (linkNext) {
        jsonObj = await this.fetchGetAlethio(linkNext, false)
      } else {
        if (currencyCode === PRIMARY_CURRENCY) {
          jsonObj = await this.fetchGetAlethio(
            `/accounts/${address}/etherTransfers`,
            true
          )
        } else {
          jsonObj = await this.fetchGetAlethio(
            `/accounts/${address}/tokenTransfers`,
            true
          )
        }
      }
      const valid = validateObject(jsonObj, AlethioAccountsTokenTransferSchema)
      if (valid) {
        const tokenTransfers: Array<AlethioTokenTransfer> = jsonObj.data
        linkNext = jsonObj.links.next
        let hasNext = jsonObj.meta.page.hasNext
        for (const tokenTransfer of tokenTransfers) {
          const txBlockheight = tokenTransfer.attributes.globalRank[0]
          if (txBlockheight > startBlock) {
            const contractAddress = tokenTransfer.relationships.token.data.id
            const currencyCode = this.getTokenCurrencyCode(contractAddress)
            if (typeof currencyCode === 'string') {
              const txLink =
                tokenTransfer.relationships.transaction.links.related
              const txJsonObj = await this.fetchGetAlethio(txLink, false)
              const txValid = validateObject(txJsonObj, AlethioAccountsTxSchema)
              if (txValid) {
                const tx = this.processAlethioTransaction(
                  tokenTransfer,
                  txJsonObj.data,
                  currencyCode
                )
                if (tx) {
                  allTransactions.push(tx)
                }
              } else {
                throw new Error(
                  `checkTxsAlethio ${txLink} response is invalid(1)`
                )
              }
            }
          } else {
            hasNext = false
            break
          }
        }
        if (!hasNext) {
          break
        }
      } else {
        throw new Error(`checkTxsAlethio response is invalid(2)`)
      }
    }

    // We init txsByCurrency with all tokens (or ETH) in order to
    // force processEthereumNetworkUpdate to set the lastChecked
    // timestamp.  Otherwise tokens w/out transactions won't get
    // throttled properly. Remember that Alethio responds with
    // txs for *all* tokens.
    const response = { tokenTxs: {}, server: 'alethio' }
    if (currencyCode !== PRIMARY_CURRENCY) {
      for (const tk of this.ethEngine.walletLocalData.enabledTokens) {
        if (tk !== PRIMARY_CURRENCY) {
          response.tokenTxs[tk] = {
            blockHeight: startBlock,
            edgeTransactions: []
          }
        }
      }
    } else {
      // ETH is singled out here because it is a different (but very
      // similar) Alethio process
      response.tokenTxs.ETH = {
        blockHeight: startBlock,
        edgeTransactions: []
      }
    }

    for (const tx: EdgeTransaction of allTransactions) {
      response.tokenTxs[tx.currencyCode].edgeTransactions.push(tx)
    }
    return response
  }

  async checkTxs(
    startBlock: number,
    currencyCode: string
  ): Promise<EthereumNetworkUpdate> {
    return asyncWaterfall([
      async () => this.checkTxsAlethio(startBlock, currencyCode),
      async () => this.checkTxsEthscan(startBlock, currencyCode)
    ]).catch(err => {
      this.ethEngine.log('checkTxs failed to update', err)
      return {}
    })
  }

  async checkTokenBalEthscan(tk: string): Promise<EthereumNetworkUpdate> {
    const address = this.ethEngine.walletLocalData.publicKey
    let jsonObj = {}
    let server

    if (tk === PRIMARY_CURRENCY) {
      const response = await this.multicastServers('eth_getBalance', address)
      jsonObj = response.result
      server = response.server
    } else {
      const tokenInfo = this.ethEngine.getTokenInfo(tk)
      const contractAddress = tokenInfo.contractAddress
      const response = await this.multicastServers(
        'getTokenBalance',
        address,
        contractAddress
      )
      jsonObj = response.result
      server = response.server
    }
    const valid = validateObject(jsonObj, EtherscanGetAccountBalance)
    if (valid) {
      const balance = jsonObj.result
      return { tokenBal: { [tk]: balance }, server }
    } else {
      throw new Error('Ethscan returned invalid JSON')
    }
  }

  async checkTokenBalBlockchair(): Promise<EthereumNetworkUpdate> {
    const address = this.ethEngine.walletLocalData.publicKey
    const jsonObj = await this.fetchGetBlockchair(
      `/ethereum/dashboards/address/${address}?erc_20=true`,
      true
    )
    const valid = validateObject(jsonObj, BlockChairAddressSchema)
    if (valid) {
      // Note: Blockchair returns eth balance and all tokens balances
      const response = {
        ETH: jsonObj.data[address].address.balance
      }

      for (const tokenData of jsonObj.data[address].layer_2.erc_20) {
        const balance = tokenData.balance
        const tokenAddress = tokenData.token_address
        const tokenSymbol = tokenData.token_symbol
        const tokenInfo = this.ethEngine.getTokenInfo(tokenSymbol)
        if (tokenInfo.contractAddress === tokenAddress) {
          response[tokenSymbol] = balance
        } else {
          // Do nothing, eg: Old DAI token balance is ignored
        }
      }
      return { tokenBal: response, server: 'blockchair' }
    } else {
      throw new Error('Blockchair returned invalid JSON')
    }
  }

  async checkTokenBal(tk: string): Promise<EthereumNetworkUpdate> {
    return asyncWaterfall([
      async () => this.checkTokenBalEthscan(tk),
      this.checkTokenBalBlockchair
    ]).catch(err => {
      this.ethEngine.log('checkTokenBal failed to update', err)
      return {}
    })
  }

  async checkAndUpdate(
    lastChecked: number = 0,
    pollMillisec: number,
    preUpdateBlockHeight: number,
    checkFunc: () => EthereumNetworkUpdate
  ) {
    const now = Date.now()
    if (now - lastChecked > pollMillisec) {
      const ethUpdate = await checkFunc()
      this.processEthereumNetworkUpdate(now, ethUpdate, preUpdateBlockHeight)
    }
  }

  getQueryHeightWithLookback(queryHeight: number): number {
    if (queryHeight > ADDRESS_QUERY_LOOKBACK_BLOCKS) {
      // Only query for transactions as far back as ADDRESS_QUERY_LOOKBACK_BLOCKS from the last time we queried transactions
      return queryHeight - ADDRESS_QUERY_LOOKBACK_BLOCKS
    } else {
      return 0
    }
  }

  async needsLoop(): Promise<void> {
    while (this.ethEngine.engineOn) {
      const preUpdateBlockHeight = this.ethEngine.walletLocalData.blockHeight
      await this.checkAndUpdate(
        this.ethNeeds.blockHeightLastChecked,
        BLOCKHEIGHT_POLL_MILLISECONDS,
        preUpdateBlockHeight,
        this.checkBlockHeight
      )

      await this.checkAndUpdate(
        this.ethNeeds.nonceLastChecked,
        NONCE_POLL_MILLISECONDS,
        preUpdateBlockHeight,
        this.checkNonce
      )

      for (const tk of this.ethEngine.walletLocalData.enabledTokens) {
        await this.checkAndUpdate(
          this.ethNeeds.tokenBalLastChecked[tk],
          BAL_POLL_MILLISECONDS,
          preUpdateBlockHeight,
          async () => this.checkTokenBal(tk)
        )

        await this.checkAndUpdate(
          this.ethNeeds.tokenTxsLastChecked[tk],
          TXS_POLL_MILLISECONDS,
          preUpdateBlockHeight,
          async () =>
            this.checkTxs(
              this.getQueryHeightWithLookback(
                this.ethEngine.walletLocalData.lastTransactionQueryHeight[tk]
              ),
              tk
            )
        )
      }

      await snooze(1000)
    }
  }

  processEthereumNetworkUpdate(
    now: number,
    ethereumNetworkUpdate: EthereumNetworkUpdate,
    preUpdateBlockHeight: number
  ) {
    if (!ethereumNetworkUpdate) return
    if (ethereumNetworkUpdate.blockHeight) {
      this.ethEngine.log(
        `ETH processEthereumNetworkUpdate blockHeight ${ethereumNetworkUpdate.server} won`
      )
      const blockHeight = ethereumNetworkUpdate.blockHeight
      this.ethEngine.log(`Got block height ${blockHeight}`)
      if (this.ethEngine.walletLocalData.blockHeight !== blockHeight) {
        this.ethNeeds.blockHeightLastChecked = now
        this.ethEngine.checkDroppedTransactionsThrottled()
        this.ethEngine.walletLocalData.blockHeight = blockHeight // Convert to decimal
        this.ethEngine.walletLocalDataDirty = true
        this.ethEngine.currencyEngineCallbacks.onBlockHeightChanged(
          this.ethEngine.walletLocalData.blockHeight
        )
      }
    }

    if (ethereumNetworkUpdate.nonce) {
      this.ethEngine.log(
        `ETH processEthereumNetworkUpdate nonce ${ethereumNetworkUpdate.server} won`
      )
      this.ethNeeds.nonceLastChecked = now
      this.ethEngine.walletLocalData.otherData.nextNonce =
        ethereumNetworkUpdate.nonce
      this.ethEngine.walletLocalDataDirty = true
    }

    if (ethereumNetworkUpdate.tokenBal) {
      this.ethEngine.log(
        `ETH processEthereumNetworkUpdate tokenBal ${ethereumNetworkUpdate.server} won`
      )
      for (const tk of Object.keys(ethereumNetworkUpdate.tokenBal)) {
        this.ethNeeds.tokenBalLastChecked[tk] = now
        this.ethEngine.updateBalance(tk, ethereumNetworkUpdate.tokenBal[tk])
      }
    }

    if (ethereumNetworkUpdate.tokenTxs) {
      this.ethEngine.log(
        `ETH processEthereumNetworkUpdate tokenTxs ${ethereumNetworkUpdate.server} won`
      )
      for (const tk of Object.keys(ethereumNetworkUpdate.tokenTxs)) {
        this.ethNeeds.tokenTxsLastChecked[tk] = now
        this.ethEngine.tokenCheckTransactionsStatus[tk] = 1
        const tuple: EdgeTransactionsBlockHeightTuple =
          ethereumNetworkUpdate.tokenTxs[tk]
        if (tuple.edgeTransactions) {
          for (const tx: EdgeTransaction of tuple.edgeTransactions) {
            this.ethEngine.addTransaction(tk, tx)
          }
          this.ethEngine.walletLocalData.lastTransactionQueryHeight[
            tk
          ] = preUpdateBlockHeight
        }
      }
      this.ethEngine.updateOnAddressesChecked()
    }

    if (this.ethEngine.transactionsChangedArray.length > 0) {
      this.ethEngine.currencyEngineCallbacks.onTransactionsChanged(
        this.ethEngine.transactionsChangedArray
      )
      this.ethEngine.transactionsChangedArray = []
    }
  }
}
