/**
 * Created by paul on 7/7/17.
 */
// @flow

import { bns } from 'biggystring'
import {
  type EdgeCurrencyEngineOptions,
  type EdgeSpendInfo,
  type EdgeTransaction,
  type EdgeWalletInfo,
  InsufficientFundsError
} from 'edge-core-js/types'
import abi from 'ethereumjs-abi'
import EthereumTx from 'ethereumjs-tx'
import EthereumUtil from 'ethereumjs-util'
import ethWallet from 'ethereumjs-wallet'

import { CurrencyEngine } from '../common/engine.js'
import {
  addHexPrefix,
  asyncWaterfall,
  bufToHex,
  getEdgeInfoServer,
  isHex,
  normalizeAddress,
  promiseAny,
  shuffleArray,
  toHex,
  validateObject
} from '../common/utils.js'
import { currencyInfo } from './ethInfo.js'
import { calcMiningFee } from './ethMiningFees.js'
import { EthereumPlugin } from './ethPlugin.js'
import {
  EthGasStationSchema,
  EtherscanGetAccountBalance,
  EtherscanGetAccountNonce,
  EtherscanGetBlockHeight,
  EtherscanGetTokenTransactions,
  EtherscanGetTransactions,
  NetworkFeesSchema,
  SuperEthGetUnconfirmedTransactions
} from './ethSchema.js'
import {
  type EthereumFee,
  type EthereumFeesGasPrice,
  type EthereumInitOptions,
  type EthereumTxOtherParams,
  type EthereumWalletOtherData,
  type EtherscanTransaction
} from './ethTypes.js'

const PRIMARY_CURRENCY = currencyInfo.currencyCode
const ACCOUNT_POLL_MILLISECONDS = 20000
const BLOCKCHAIN_POLL_MILLISECONDS = 20000
const TRANSACTION_POLL_MILLISECONDS = 20000
const UNCONFIRMED_TRANSACTION_POLL_MILLISECONDS = 3000
const NETWORKFEES_POLL_MILLISECONDS = 60 * 10 * 1000 // 10 minutes
const ADDRESS_QUERY_LOOKBACK_BLOCKS = 4 * 60 * 24 * 7 // ~ one week
const NUM_TRANSACTIONS_TO_QUERY = 50
const WEI_MULTIPLIER = 100000000

type EthFunction =
  | 'broadcastTx'
  | 'eth_blockNumber'
  | 'eth_getTransactionCount'
  | 'eth_getBalance'
  | 'getTokenBalance'
  | 'getTransactions'

type BroadcastResults = {
  incrementNonce: boolean,
  decrementNonce: boolean
}

async function broadcastWrapper (promise: Promise<Object>, server: string) {
  const out = {
    result: await promise,
    server
  }
  return out
}

export class EthereumEngine extends CurrencyEngine {
  ethereumPlugin: EthereumPlugin
  otherData: EthereumWalletOtherData
  initOptions: EthereumInitOptions

  constructor (
    currencyPlugin: EthereumPlugin,
    walletInfo: EdgeWalletInfo,
    initOptions: EthereumInitOptions,
    opts: EdgeCurrencyEngineOptions
  ) {
    super(currencyPlugin, walletInfo, opts)
    if (typeof this.walletInfo.keys.ethereumKey !== 'string') {
      if (walletInfo.keys.keys && walletInfo.keys.keys.ethereumKey) {
        this.walletInfo.keys.ethereumKey = walletInfo.keys.keys.ethereumKey
      }
    }
    this.currencyPlugin = currencyPlugin
    this.initOptions = initOptions
  }

  async fetchGetEtherscan (server: string, cmd: string) {
    const { etherscanApiKey } = this.initOptions
    let apiKey = ''
    if (
      etherscanApiKey &&
      etherscanApiKey.length > 5 &&
      server.includes('etherscan')
    ) {
      apiKey = '&apikey=' + etherscanApiKey
    }
    const url = `${server}/api${cmd}${apiKey}`
    return this.fetchGet(url)
  }

  async fetchGet (url: string) {
    const response = await this.io.fetch(url, {
      method: 'GET'
    })
    if (!response.ok) {
      const {
        blockcypherApiKey,
        etherscanApiKey,
        infuraProjectId
      } = this.initOptions
      if (blockcypherApiKey) url = url.replace(blockcypherApiKey, 'private')
      if (etherscanApiKey) url = url.replace(etherscanApiKey, 'private')
      if (infuraProjectId) url = url.replace(infuraProjectId, 'private')
      throw new Error(
        `The server returned error code ${response.status} for ${url}`
      )
    }
    return response.json()
  }

  async fetchPostBlockcypher (cmd: string, body: any) {
    const { blockcypherApiKey } = this.initOptions
    let apiKey = ''
    if (blockcypherApiKey && blockcypherApiKey.length > 5) {
      apiKey = '&token=' + blockcypherApiKey
    }
    const url = `${
      this.currencyInfo.defaultSettings.otherSettings.blockcypherApiServers[0]
    }/${cmd}${apiKey}`
    const response = await this.io.fetch(url, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      method: 'POST',
      body: JSON.stringify(body)
    })
    return response.json()
  }

  async checkBlockchainInnerLoop () {
    try {
      const jsonObj = await this.multicastServers('eth_blockNumber')
      const valid = validateObject(jsonObj, EtherscanGetBlockHeight)
      if (valid) {
        const blockHeight: number = parseInt(jsonObj.result, 16)
        this.log(`Got block height ${blockHeight}`)
        if (this.walletLocalData.blockHeight !== blockHeight) {
          this.checkDroppedTransactionsThrottled()
          this.walletLocalData.blockHeight = blockHeight // Convert to decimal
          this.walletLocalDataDirty = true
          this.currencyEngineCallbacks.onBlockHeightChanged(
            this.walletLocalData.blockHeight
          )
        }
      }
    } catch (err) {
      this.log('Error fetching height: ' + err)
    }
  }

  updateBalance (tk: string, balance: string) {
    if (typeof this.walletLocalData.totalBalances[tk] === 'undefined') {
      this.walletLocalData.totalBalances[tk] = '0'
    }
    if (!bns.eq(balance, this.walletLocalData.totalBalances[tk])) {
      this.walletLocalData.totalBalances[tk] = balance
      this.log(tk + ': token Address balance: ' + balance)
      this.currencyEngineCallbacks.onBalanceChanged(tk, balance)
    }
    this.tokenCheckBalanceStatus[tk] = 1
    this.updateOnAddressesChecked()
  }

  async checkAccountFetch (address: string) {
    let jsonObj = {}
    let valid = false

    try {
      jsonObj = await this.multicastServers('eth_getBalance', address)
      valid = validateObject(jsonObj, EtherscanGetAccountBalance)
      if (valid) {
        const balance = jsonObj.result
        this.updateBalance('ETH', balance)
      }
    } catch (e) {
      this.log(`Error checking token balance: ETH`)
    }
  }

  async checkTokenBalanceFetch (
    address: string,
    contractAddress: string,
    tk: string
  ) {
    let jsonObj = {}
    let valid = false

    try {
      jsonObj = await this.multicastServers(
        'getTokenBalance',
        address,
        contractAddress
      )
      valid = validateObject(jsonObj, EtherscanGetAccountBalance)
      if (valid) {
        const balance = jsonObj.result
        this.updateBalance(tk, balance)
      }
    } catch (e) {
      this.log(`Error checking token balance: ${tk}`)
    }
  }

  async checkAccountNonceFetch (address: string) {
    try {
      const jsonObj = await this.multicastServers(
        'eth_getTransactionCount',
        address
      )
      const valid = validateObject(jsonObj, EtherscanGetAccountNonce)
      const nonce = bns.add('0', jsonObj.result)
      if (valid && this.walletLocalData.otherData.nextNonce !== nonce) {
        this.walletLocalData.otherData.nextNonce = nonce
        this.walletLocalDataDirty = true
      }
    } catch (e) {
      this.log(`Error checking account nonce`, e)
    }
  }

  async checkAccountInnerLoop () {
    const address = this.walletLocalData.publicKey
    try {
      // Ethereum only has one address
      const promiseArray = []

      // ************************************
      // Fetch token balances
      // ************************************
      // https://api.etherscan.io/api?module=account&action=tokenbalance&contractaddress=0x57d90b64a1a57749b0f932f1a3395792e12e7055&address=0xe04f27eb70e025b78871a2ad7eabe85e61212761&tag=latest&apikey=YourApiKeyToken
      for (const tk of this.walletLocalData.enabledTokens) {
        if (tk === PRIMARY_CURRENCY) {
          promiseArray.push(this.checkAccountFetch(address))
        } else {
          const tokenInfo = this.getTokenInfo(tk)
          if (tokenInfo && typeof tokenInfo.contractAddress === 'string') {
            promiseArray.push(
              this.checkTokenBalanceFetch(
                address,
                tokenInfo.contractAddress,
                tk
              )
            )
          } else {
            continue
          }
        }
      }
      promiseArray.push(this.checkAccountNonceFetch(address))
      await Promise.all(promiseArray)
    } catch (e) {}
  }

  processEtherscanTransaction (tx: EtherscanTransaction, currencyCode: string) {
    let netNativeAmount: string // Amount received into wallet
    const ourReceiveAddresses: Array<string> = []
    let nativeNetworkFee: string

    if (tx.contractAddress) {
      nativeNetworkFee = '0'
    } else {
      nativeNetworkFee = bns.mul(tx.gasPrice, tx.gasUsed)
    }

    if (
      tx.from.toLowerCase() === this.walletLocalData.publicKey.toLowerCase()
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
      ourReceiveAddresses.push(this.walletLocalData.publicKey.toLowerCase())
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

    this.addTransaction(currencyCode, edgeTransaction)
  }

  async checkTransactionsFetch (
    startBlock: number,
    currencyCode: string
  ): Promise<boolean> {
    const address = this.walletLocalData.publicKey
    let checkAddressSuccess = false
    let page = 1
    let contractAddress = ''
    let schema

    if (currencyCode !== PRIMARY_CURRENCY) {
      const tokenInfo = this.getTokenInfo(currencyCode)
      if (tokenInfo && typeof tokenInfo.contractAddress === 'string') {
        contractAddress = tokenInfo.contractAddress
        schema = EtherscanGetTokenTransactions
      } else {
        return false
      }
    } else {
      schema = EtherscanGetTransactions
    }

    try {
      while (1) {
        const offset = NUM_TRANSACTIONS_TO_QUERY
        const jsonObj = await this.multicastServers('getTransactions', {
          currencyCode,
          address,
          startBlock,
          page,
          offset,
          contractAddress
        })
        const valid = validateObject(jsonObj, schema)
        if (valid) {
          const transactions = jsonObj.result
          for (let i = 0; i < transactions.length; i++) {
            const tx = transactions[i]
            this.processEtherscanTransaction(tx, currencyCode)
          }
          if (transactions.length < NUM_TRANSACTIONS_TO_QUERY) {
            checkAddressSuccess = true
            break
          }
          page++
        } else {
          break
        }
      }
    } catch (e) {
      this.log(
        `Error checkTransactionsFetch ETH: ${this.walletLocalData.publicKey}`,
        e
      )
    }

    if (checkAddressSuccess) {
      this.tokenCheckTransactionsStatus[currencyCode] = 1
      this.updateOnAddressesChecked()
      return true
    } else {
      return false
    }
  }

  processUnconfirmedTransaction (tx: Object) {
    const fromAddress = '0x' + tx.inputs[0].addresses[0]
    const toAddress = '0x' + tx.outputs[0].addresses[0]
    const epochTime = Date.parse(tx.received) / 1000
    const ourReceiveAddresses: Array<string> = []

    let nativeAmount: string
    if (
      normalizeAddress(fromAddress) ===
      normalizeAddress(this.walletLocalData.publicKey)
    ) {
      if (fromAddress === toAddress) {
        // Spend to self
        nativeAmount = bns.sub('0', tx.fees.toString(10))
      } else {
        nativeAmount = (0 - tx.total).toString(10)
        nativeAmount = bns.sub(nativeAmount, tx.fees.toString(10))
      }
    } else {
      nativeAmount = tx.total.toString(10)
      ourReceiveAddresses.push(this.walletLocalData.publicKey)
    }

    const otherParams: EthereumTxOtherParams = {
      from: [fromAddress],
      to: [toAddress],
      gas: '',
      gasPrice: '',
      gasUsed: tx.fees.toString(10),
      cumulativeGasUsed: '',
      errorVal: 0,
      tokenRecipientAddress: null
    }

    const edgeTransaction: EdgeTransaction = {
      txid: addHexPrefix(tx.hash),
      date: epochTime,
      currencyCode: 'ETH',
      blockHeight: 0,
      nativeAmount,
      networkFee: tx.fees.toString(10),
      ourReceiveAddresses,
      signedTx: '',
      otherParams
    }
    this.addTransaction('ETH', edgeTransaction)
  }

  async checkUnconfirmedTransactionsInnerLoop () {
    const address = normalizeAddress(this.walletLocalData.publicKey)
    const url = `${
      this.currencyInfo.defaultSettings.otherSettings.superethServers[0]
    }/v1/eth/main/txs/${address}`
    let jsonObj = null
    try {
      jsonObj = await this.fetchGet(url)
    } catch (e) {
      this.log(e)
      this.log('Failed to fetch unconfirmed transactions')
      return
    }

    const valid = validateObject(jsonObj, SuperEthGetUnconfirmedTransactions)
    if (valid) {
      const transactions = jsonObj
      for (const tx of transactions) {
        if (
          normalizeAddress(tx.inputs[0].addresses[0]) === address ||
          normalizeAddress(tx.outputs[0].addresses[0]) === address
        ) {
          this.processUnconfirmedTransaction(tx)
        }
      }
    } else {
      this.log('Invalid data for unconfirmed transactions')
    }
    if (this.transactionsChangedArray.length > 0) {
      this.currencyEngineCallbacks.onTransactionsChanged(
        this.transactionsChangedArray
      )
      this.transactionsChangedArray = []
    }
  }

  async checkTransactionsInnerLoop () {
    const blockHeight = this.walletLocalData.blockHeight
    let startBlock: number = 0
    const promiseArray = []

    if (
      this.walletLocalData.lastAddressQueryHeight >
      ADDRESS_QUERY_LOOKBACK_BLOCKS
    ) {
      // Only query for transactions as far back as ADDRESS_QUERY_LOOKBACK_BLOCKS from the last time we queried transactions
      startBlock =
        this.walletLocalData.lastAddressQueryHeight -
        ADDRESS_QUERY_LOOKBACK_BLOCKS
    }

    for (const currencyCode of this.walletLocalData.enabledTokens) {
      promiseArray.push(this.checkTransactionsFetch(startBlock, currencyCode))
    }

    let resultArray = []
    try {
      resultArray = await Promise.all(promiseArray)
    } catch (e) {
      this.log('Failed to query transactions')
      this.log(e.name)
      this.log(e.message)
    }
    let successCount = 0
    for (const r of resultArray) {
      if (r) successCount++
    }
    if (successCount === promiseArray.length) {
      this.walletLocalData.lastAddressQueryHeight = blockHeight
    }
    if (this.transactionsChangedArray.length > 0) {
      this.currencyEngineCallbacks.onTransactionsChanged(
        this.transactionsChangedArray
      )
      this.transactionsChangedArray = []
    }
  }

  async checkUpdateNetworkFees () {
    try {
      const infoServer = getEdgeInfoServer()
      const url = `${infoServer}/v1/networkFees/ETH`
      const jsonObj = await this.fetchGet(url)
      const valid = validateObject(jsonObj, NetworkFeesSchema)

      if (valid) {
        if (
          JSON.stringify(this.walletLocalData.otherData.networkFees) !==
          JSON.stringify(jsonObj)
        ) {
          this.walletLocalData.otherData.networkFees = jsonObj
          this.walletLocalDataDirty = true
        }
      } else {
        this.log('Error: Fetched invalid networkFees')
      }
    } catch (err) {
      this.log('Error fetching networkFees from Edge info server')
      this.log(err)
    }

    try {
      const url = 'https://www.ethgasstation.info/json/ethgasAPI.json'
      const jsonObj = await this.fetchGet(url)
      const valid = validateObject(jsonObj, EthGasStationSchema)

      if (valid) {
        const fees = this.walletLocalData.otherData.networkFees
        const ethereumFee: EthereumFee = fees['default']
        if (!ethereumFee.gasPrice) {
          return
        }
        const gasPrice: EthereumFeesGasPrice = ethereumFee.gasPrice

        const safeLow = jsonObj.safeLow
        let average = jsonObj.average
        let fast = jsonObj.fast
        let fastest = jsonObj.fastest

        // Sanity checks
        if (safeLow < 1 || safeLow > 3000) {
          console.log('Invalid safeLow value from EthGasStation')
          return
        }
        if (average < 1 || average > 3000) {
          console.log('Invalid average value from EthGasStation')
          return
        }
        if (fast < 1 || fast > 3000) {
          console.log('Invalid fastest value from EthGasStation')
          return
        }
        if (fastest < 1 || fastest > 3000) {
          console.log('Invalid fastest value from EthGasStation')
          return
        }

        // Correct inconsistencies
        if (average <= safeLow) average = safeLow + 1
        if (fast <= average) fast = average + 1
        if (fastest <= fast) fastest = fast + 1

        let lowFee = safeLow
        let standardFeeLow = fast
        let standardFeeHigh = (fast + fastest) * 0.75
        let highFee = fastest

        lowFee = (Math.round(lowFee) * WEI_MULTIPLIER).toString()
        standardFeeLow = (
          Math.round(standardFeeLow) * WEI_MULTIPLIER
        ).toString()
        standardFeeHigh = (
          Math.round(standardFeeHigh) * WEI_MULTIPLIER
        ).toString()
        highFee = (Math.round(highFee) * WEI_MULTIPLIER).toString()

        if (
          gasPrice.lowFee !== lowFee ||
          gasPrice.standardFeeLow !== standardFeeLow ||
          gasPrice.highFee !== highFee ||
          gasPrice.standardFeeHigh !== standardFeeHigh
        ) {
          gasPrice.lowFee = lowFee
          gasPrice.standardFeeLow = standardFeeLow
          gasPrice.highFee = highFee
          gasPrice.standardFeeHigh = standardFeeHigh
          this.walletLocalDataDirty = true
        }
      } else {
        this.log('Error: Fetched invalid networkFees from EthGasStation')
      }
    } catch (err) {
      this.log('Error fetching networkFees from EthGasStation')
      this.log(err)
    }
  }

  async multicastServers (func: EthFunction, ...params: any): Promise<any> {
    let out = { result: '', server: 'no server' }
    let funcs, funcs2, url
    switch (func) {
      case 'broadcastTx':
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

        this.log(`ETH multicastServers ${func} ${out.server} won`)
        break
      case 'eth_blockNumber':
        funcs = this.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
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
              this.log(msg)
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

      case 'eth_getTransactionCount':
        url = `?module=proxy&action=eth_getTransactionCount&address=${
          params[0]
        }&tag=latest`
        funcs = this.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            if (!server.includes('etherscan')) {
              throw new Error(
                `Unsupported command eth_getTransactionCount in ${server}`
              )
            }
            const result = await this.fetchGetEtherscan(server, url)
            if (typeof result.result !== 'string') {
              const msg = `Invalid return value eth_getTransactionCount in ${server}`
              this.log(msg)
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
        funcs = this.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            const result = await this.fetchGetEtherscan(server, url)
            if (!result.result || typeof result.result !== 'string') {
              const msg = `Invalid return value eth_getBalance in ${server}`
              this.log(msg)
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
        funcs = this.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            const result = await this.fetchGetEtherscan(server, url)
            if (!result.result || typeof result.result !== 'string') {
              const msg = `Invalid return value getTokenBalance in ${server}`
              this.log(msg)
              throw new Error(msg)
            }
            return { server, result }
          }
        )
        // Randomize array
        funcs = shuffleArray(funcs)
        out = await asyncWaterfall(funcs)
        break
      case 'getTransactions':
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
        funcs = this.currencyInfo.defaultSettings.otherSettings.etherscanApiServers.map(
          server => async () => {
            const result = await this.fetchGetEtherscan(server, url)
            if (
              typeof result.result !== 'object' ||
              typeof result.result.length !== 'number'
            ) {
              const msg = `Invalid return value getTransactions in ${server}`
              this.log(msg)
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
    this.log(`ETH multicastServers ${func} ${out.server} won`)

    return out.result
  }

  async clearBlockchainCache () {
    await super.clearBlockchainCache()
    this.otherData.nextNonce = '0'
    this.otherData.unconfirmedNextNonce = '0'
  }

  // ****************************************************************************
  // Public methods
  // ****************************************************************************

  async startEngine () {
    this.engineOn = true
    this.addToLoop('checkBlockchainInnerLoop', BLOCKCHAIN_POLL_MILLISECONDS)
    this.addToLoop('checkAccountInnerLoop', ACCOUNT_POLL_MILLISECONDS)
    this.addToLoop('checkUpdateNetworkFees', NETWORKFEES_POLL_MILLISECONDS)
    this.addToLoop('checkTransactionsInnerLoop', TRANSACTION_POLL_MILLISECONDS)
    this.addToLoop(
      'checkUnconfirmedTransactionsInnerLoop',
      UNCONFIRMED_TRANSACTION_POLL_MILLISECONDS
    )
    super.startEngine()
  }

  async resyncBlockchain (): Promise<void> {
    await this.killEngine()
    await this.clearBlockchainCache()
    await this.startEngine()
  }

  async makeSpend (edgeSpendInfoIn: EdgeSpendInfo) {
    const { edgeSpendInfo, currencyCode, otherParams = {} } = super.makeSpend(edgeSpendInfoIn)

    // Ethereum can only have one output
    if (edgeSpendInfo.spendTargets.length !== 1) {
      throw new Error('Error: only one output allowed')
    }

    const spendTarget = edgeSpendInfo.spendTargets[0]
    const publicAddress = spendTarget.publicAddress
    if (!EthereumUtil.isValidAddress(publicAddress)) {
      throw new TypeError('Invalid Ethereum address')
    }

    const data =
      spendTarget.otherParams != null ? spendTarget.otherParams.data : void 0

    const { gasLimit, gasPrice } = calcMiningFee(
      edgeSpendInfo,
      this.walletLocalData.otherData.networkFees
    )

    let otherParamsOut: Object = {}
    if (currencyCode === PRIMARY_CURRENCY) {
      const ethParams: EthereumTxOtherParams = {
        from: [this.walletLocalData.publicKey],
        to: [publicAddress],
        gas: gasLimit,
        gasPrice: gasPrice,
        gasUsed: '0',
        cumulativeGasUsed: '0',
        errorVal: 0,
        tokenRecipientAddress: null,
        data: data
      }
      otherParamsOut = { ...otherParams, ...ethParams }
    } else {
      let contractAddress = ''
      if (data) {
        contractAddress = publicAddress
      } else {
        const tokenInfo = this.getTokenInfo(currencyCode)
        if (!tokenInfo || typeof tokenInfo.contractAddress !== 'string') {
          throw new Error(
            'Error: Token not supported or invalid contract address'
          )
        }

        contractAddress = tokenInfo.contractAddress
      }

      const ethParams: EthereumTxOtherParams = {
        from: [this.walletLocalData.publicKey],
        to: [contractAddress],
        gas: gasLimit,
        gasPrice: gasPrice,
        gasUsed: '0',
        cumulativeGasUsed: '0',
        errorVal: 0,
        tokenRecipientAddress: publicAddress,
        data: data
      }
      otherParamsOut = { ...otherParams, ...ethParams }
    }

    let nativeAmount = edgeSpendInfo.spendTargets[0].nativeAmount
    const balanceEth = this.walletLocalData.totalBalances[
      this.currencyInfo.currencyCode
    ]
    let nativeNetworkFee = bns.mul(gasPrice, gasLimit)
    let totalTxAmount = '0'
    let parentNetworkFee = null

    const byPassBalanceCheck = otherParams && otherParams.txOptions ? otherParams.txOptions.byPassBalanceCheck : false

    if (currencyCode === PRIMARY_CURRENCY) {
      totalTxAmount = bns.add(nativeNetworkFee, nativeAmount)
      if (bns.gt(totalTxAmount, balanceEth) && !byPassBalanceCheck) {
        throw new InsufficientFundsError()
      }
      nativeAmount = bns.mul(totalTxAmount, '-1')
    } else {
      parentNetworkFee = nativeNetworkFee

      if (bns.gt(nativeNetworkFee, balanceEth) && !byPassBalanceCheck) {
        throw new InsufficientFundsError('Insufficient ETH for transaction fee')
      }
      const balanceToken = this.walletLocalData.totalBalances[currencyCode]
      if (bns.gt(nativeAmount, balanceToken) && !byPassBalanceCheck) {
        throw new InsufficientFundsError()
      }
      nativeNetworkFee = '0' // Do not show a fee for token transactions.
      nativeAmount = bns.mul(nativeAmount, '-1')
    }
    // **********************************
    // Create the unsigned EdgeTransaction

    const edgeTransaction: EdgeTransaction = {
      txid: '', // txid
      date: 0, // date
      currencyCode, // currencyCode
      blockHeight: 0, // blockHeight
      nativeAmount, // nativeAmount
      networkFee: nativeNetworkFee, // networkFee
      ourReceiveAddresses: [], // ourReceiveAddresses
      signedTx: '', // signedTx
      otherParams: otherParamsOut // otherParams
    }

    if (parentNetworkFee) {
      edgeTransaction.parentNetworkFee = parentNetworkFee
    }

    return edgeTransaction
  }

  async signTx (edgeTransaction: EdgeTransaction): Promise<EdgeTransaction> {
    // Do signing

    const gasLimitHex = toHex(edgeTransaction.otherParams.gas)
    const gasPriceHex = toHex(edgeTransaction.otherParams.gasPrice)
    let nativeAmountHex

    if (edgeTransaction.currencyCode === PRIMARY_CURRENCY) {
      // Remove the networkFee from the nativeAmount
      const nativeAmount = bns.add(
        edgeTransaction.nativeAmount,
        edgeTransaction.networkFee
      )
      nativeAmountHex = bns.mul('-1', nativeAmount, 16)
    } else {
      nativeAmountHex = bns.mul('-1', edgeTransaction.nativeAmount, 16)
    }

    let nonceHex
    // Use an unconfirmed nonce if
    // 1. We have unconfirmed spending txs in the transaction list
    // 2. It is greater than the confirmed nonce
    // 3. Is no more than 5 higher than confirmed nonce
    if (
      this.walletLocalData.numUnconfirmedSpendTxs &&
      bns.gt(
        this.walletLocalData.otherData.unconfirmedNextNonce,
        this.walletLocalData.otherData.nextNonce
      )
    ) {
      const diff = bns.sub(
        this.walletLocalData.otherData.unconfirmedNextNonce,
        this.walletLocalData.otherData.nextNonce
      )
      if (bns.lte(diff, '5')) {
        nonceHex = toHex(this.walletLocalData.otherData.unconfirmedNextNonce)
        this.walletLocalData.otherData.unconfirmedNextNonce = bns.add(
          this.walletLocalData.otherData.unconfirmedNextNonce,
          '1'
        )
        this.walletLocalDataDirty = true
      } else {
        const e = new Error('Excessive pending spend transactions')
        e.name = 'ErrorExcessivePendingSpends'
        throw e
      }
    }
    if (!nonceHex) {
      nonceHex = toHex(this.walletLocalData.otherData.nextNonce)
      this.walletLocalData.otherData.unconfirmedNextNonce = bns.add(
        this.walletLocalData.otherData.nextNonce,
        '1'
      )
    }

    let data
    if (edgeTransaction.otherParams.data != null) {
      data = edgeTransaction.otherParams.data
    } else if (edgeTransaction.currencyCode === PRIMARY_CURRENCY) {
      data = ''
    } else {
      const dataArray = abi.simpleEncode(
        'transfer(address,uint256):(uint256)',
        edgeTransaction.otherParams.tokenRecipientAddress,
        nativeAmountHex
      )
      data = '0x' + Buffer.from(dataArray).toString('hex')
      nativeAmountHex = '0x00'
    }

    const txParams = {
      nonce: nonceHex,
      gasPrice: gasPriceHex,
      gasLimit: gasLimitHex,
      to: edgeTransaction.otherParams.to[0],
      value: nativeAmountHex,
      data: data,
      // EIP 155 chainId - mainnet: 1, ropsten: 3
      chainId: 1
    }

    const privKey = Buffer.from(this.walletInfo.keys.ethereumKey, 'hex')
    const wallet = ethWallet.fromPrivateKey(privKey)

    this.log(wallet.getAddressString())

    this.log('signTx txParams', txParams)
    const tx = new EthereumTx(txParams)
    tx.sign(privKey)

    edgeTransaction.signedTx = bufToHex(tx.serialize())
    edgeTransaction.txid = bufToHex(tx.hash())
    edgeTransaction.date = Date.now() / 1000

    return edgeTransaction
  }

  async broadcastEtherscan (
    edgeTransaction: EdgeTransaction
  ): Promise<BroadcastResults> {
    const transactionParsed = JSON.stringify(edgeTransaction, null, 2)

    this.log(`Etherscan: sent transaction to network:\n${transactionParsed}\n`)
    const url = `?module=proxy&action=eth_sendRawTransaction&hex=${
      edgeTransaction.signedTx
    }`
    const jsonObj = await this.fetchGetEtherscan(
      this.currencyInfo.defaultSettings.otherSettings.etherscanApiServers[0],
      url
    )

    this.log('broadcastEtherscan jsonObj:', jsonObj)

    if (typeof jsonObj.error !== 'undefined') {
      this.log('EtherScan: Error sending transaction')
      throw jsonObj.error
    } else if (typeof jsonObj.result === 'string') {
      // Success!!
      return jsonObj
    } else {
      throw new Error('Invalid return value on transaction send')
    }
  }

  async fetchPostInfura (method: string, params: Object) {
    const { infuraProjectId } = this.initOptions
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
    const response = await this.io.fetch(url, {
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

  async broadcastInfura (
    edgeTransaction: EdgeTransaction
  ): Promise<BroadcastResults> {
    const transactionParsed = JSON.stringify(edgeTransaction, null, 2)

    const method = 'eth_sendRawTransaction'
    const params = [edgeTransaction.signedTx]

    const jsonObj = await this.fetchPostInfura(method, params)

    if (typeof jsonObj.error !== 'undefined') {
      this.log('EtherScan: Error sending transaction')
      throw jsonObj.error
    } else if (typeof jsonObj.result === 'string') {
      // Success!!
      this.log(`Infura: sent transaction to network:\n${transactionParsed}\n`)
      return jsonObj
    } else {
      throw new Error('Invalid return value on transaction send')
    }
  }

  async broadcastBlockCypher (
    edgeTransaction: EdgeTransaction
  ): Promise<BroadcastResults> {
    const transactionParsed = JSON.stringify(edgeTransaction, null, 2)
    this.log(
      `Blockcypher: sending transaction to network:\n${transactionParsed}\n`
    )

    const url = 'v1/eth/main/txs/push'
    const hexTx = edgeTransaction.signedTx.replace('0x', '')
    const jsonObj = await this.fetchPostBlockcypher(url, { tx: hexTx })

    this.log('broadcastBlockCypher jsonObj:', jsonObj)
    if (typeof jsonObj.error !== 'undefined') {
      this.log('BlockCypher: Error sending transaction')
      throw jsonObj.error
    } else if (jsonObj.tx && typeof jsonObj.tx.hash === 'string') {
      this.log(`Blockcypher success sending txid ${jsonObj.tx.hash}`)
      // Success!!
      return jsonObj
    } else {
      throw new Error('Invalid return value on transaction send')
    }
  }

  async broadcastTx (
    edgeTransaction: EdgeTransaction
  ): Promise<EdgeTransaction> {
    const result = await this.multicastServers('broadcastTx', edgeTransaction)

    // Success
    this.log(`SUCCESS broadcastTx\n${JSON.stringify(result)}`)
    this.log('edgeTransaction = ', edgeTransaction)

    return edgeTransaction
  }

  getDisplayPrivateSeed () {
    if (this.walletInfo.keys && this.walletInfo.keys.ethereumKey) {
      return this.walletInfo.keys.ethereumKey
    }
    return ''
  }

  getDisplayPublicSeed () {
    if (this.walletInfo.keys && this.walletInfo.keys.publicKey) {
      return this.walletInfo.keys.publicKey
    }
    return ''
  }
}

export { CurrencyEngine }
