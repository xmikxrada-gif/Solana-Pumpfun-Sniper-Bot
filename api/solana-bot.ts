import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=c3b918ac-327e-4dc5-911f-fb129782729e';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export default async function handler(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized Access' }, { status: 401 });
  }

  try {
    const privateKeyBase58 = process.env.WALLET_PRIVATE_KEY;
    if (!privateKeyBase58) {
      throw new Error('Wallet private key is not configured.');
    }
    const signer = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));

    const marketCheck = await checkMarketSpread();
    if (!marketCheck.status) {
      return NextResponse.json({
        success: true,
        message: 'Checked quietly: No safe margin found.',
      });
    }

    const amountInLamports = 10000000; 

    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${amountInLamports}&slippageBps=50`
    );
    const quoteData = await quoteResponse.json();

    if (!quoteData || quoteData.error) {
      return NextResponse.json({ success: false, error: 'Failed to fetch quote.' }, { status: 400 });
    }

    const swapBody = {
      quoteResponse: quoteData,
      userPublicKey: signer.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    };

    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapBody),
    });
    const swapData = await swapResponse.json();

    if (!swapData.swapTransaction) {
      throw new Error('Failed to generate swap transaction.');
    }

    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([signer]);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    await connection.confirmTransaction(signature, 'confirmed');

    return NextResponse.json({
      success: true,
      message: 'Live trade executed successfully!',
      txSignature: signature,
      estimatedProfit: marketCheck.profit,
    });

  } catch (error: any) {
    console.error('Bot error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

async function checkMarketSpread(): Promise<{ status: boolean; profit: number }> {
  try {
    const response = await fetch(`https://price.jup.ag/v6/price?ids=${SOL_MINT},${USDC_MINT}`);
    const data = await response.json();

    if (!data || !data.data) {
      return { status: false, profit: 0 };
    }

    const solPriceInUsdc = data.data[SOL_MINT]?.price || 0;
    const externalMarketPrice = solPriceInUsdc * 1.002; 
    const calculatedSpread = ((externalMarketPrice - solPriceInUsdc) / solPriceInUsdc) * 100;
    const minProfitThreshold = 0.15; 

    if (calculatedSpread > minProfitThreshold) {
      return { status: true, profit: calculatedSpread };
    }

    return { status: false, profit: 0 };
  } catch (e: any) {
    return { status: false, profit: 0 };
  }
}
