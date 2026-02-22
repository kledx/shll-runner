import type { Address } from "viem";

export type SupportedChainId = 56 | 97;

export type ChainAddressBook = {
    chainId: SupportedChainId;
    router: Address;
    wbnb: Address;
    usdt: Address;
    busd: Address;
    usdc: Address;
};

const MAINNET: ChainAddressBook = {
    chainId: 56,
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    busd: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
};

const TESTNET: ChainAddressBook = {
    chainId: 97,
    router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    wbnb: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    usdt: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    busd: "0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee",
    usdc: "0x64544969ed7EBf5f083679233325356EbE738930",
};

const MAINNET_TO_TESTNET: Record<string, Address> = {
    [MAINNET.router.toLowerCase()]: TESTNET.router,
    [MAINNET.wbnb.toLowerCase()]: TESTNET.wbnb,
    [MAINNET.usdt.toLowerCase()]: TESTNET.usdt,
    [MAINNET.busd.toLowerCase()]: TESTNET.busd,
    [MAINNET.usdc.toLowerCase()]: TESTNET.usdc,
    // PancakeSwap V3
    ["0x13f4ea83d0bd40e75c8222255bc855a974568dd4"]: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
};

const TESTNET_TO_MAINNET: Record<string, Address> = {
    [TESTNET.router.toLowerCase()]: MAINNET.router,
    [TESTNET.wbnb.toLowerCase()]: MAINNET.wbnb,
    [TESTNET.usdt.toLowerCase()]: MAINNET.usdt,
    [TESTNET.busd.toLowerCase()]: MAINNET.busd,
    [TESTNET.usdc.toLowerCase()]: MAINNET.usdc,
    // PancakeSwap V3
    ["0x1b81d678ffb9c0263b24a97847620c99d213eb14"]: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
};

function parseChainId(raw: string | number | undefined): SupportedChainId {
    const n = typeof raw === "number" ? raw : Number.parseInt(raw ?? "", 10);
    return n === 56 ? 56 : 97;
}

export function getChainIdFromEnv(): SupportedChainId {
    return parseChainId(process.env.CHAIN_ID);
}

export function getChainAddressBook(chainIdRaw: string | number = getChainIdFromEnv()): ChainAddressBook {
    return parseChainId(chainIdRaw) === 56 ? MAINNET : TESTNET;
}

export function normalizeKnownAddressForChain(
    address: string,
    chainIdRaw: string | number = getChainIdFromEnv(),
): string {
    if (!address || !address.startsWith("0x")) return address;
    const chainId = parseChainId(chainIdRaw);
    const lookup = chainId === 56 ? TESTNET_TO_MAINNET : MAINNET_TO_TESTNET;
    return lookup[address.toLowerCase()] ?? address;
}
