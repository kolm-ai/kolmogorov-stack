#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(KolmRN, NSObject)

RCT_EXTERN_METHOD(load:(NSString *)localPath
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(predict:(NSString *)handle
                  text:(NSString *)text
                  maxTokens:(nonnull NSNumber *)maxTokens
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(dispose:(NSString *)handle
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
