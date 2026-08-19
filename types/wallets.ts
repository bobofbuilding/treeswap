export interface EthereumRequestArguments {
  readonly method: string;
  readonly params?: readonly unknown[] | object;
}

export interface EthereumProvider {
  request(args: EthereumRequestArguments): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface WebLNProvider {
  enable(): Promise<void>;
  sendPayment(paymentRequest: string): Promise<{ preimage?: string }>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
    webln?: WebLNProvider;
  }
}
