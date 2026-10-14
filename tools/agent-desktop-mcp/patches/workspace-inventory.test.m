// macOS-only regression. Compile with -I pointing at the upstream bridge directory.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <assert.h>
#include <stdio.h>
#include "appkit_bridge.m"

@interface TestApplication : NSObject
@property int32_t processIdentifier;
@property(copy) NSString *localizedName;
@property NSApplicationActivationPolicy activationPolicy;
@end
@implementation TestApplication
- (BOOL)isKindOfClass:(Class)cls {
    return cls == [NSRunningApplication class] || [super isKindOfClass:cls];
}
- (NSDate *)launchDate { return [NSDate dateWithTimeIntervalSince1970:1700000000]; }
- (NSString *)bundleIdentifier { return @"test.inventory.fixture"; }
@end

static NSArray *apps;
static NSArray *runningApplications(id self, SEL selector) { return apps; }
static id frontmostApplication(id self, SEL selector) { return nil; }
static TestApplication *record(int32_t pid, NSString *name) {
    TestApplication *app = [TestApplication new];
    app.processIdentifier = pid;
    app.localizedName = name;
    app.activationPolicy = NSApplicationActivationPolicyRegular;
    return app;
}
static NSDictionary *snapshot(uint8_t expectedStatus) {
    AgentDesktopBytesResult result = agent_desktop_copy_workspace_snapshot_json();
    assert(result.status == expectedStatus);
    NSDictionary *json = nil;
    if (result.status == 0) {
        NSData *data = [NSData dataWithBytes:result.bytes length:result.length];
        json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        assert(json != nil);
    }
    agent_desktop_free_bridge_bytes(result.bytes);
    return json;
}
int main(void) {
    @autoreleasepool {
        Method running = class_getInstanceMethod([NSWorkspace class], @selector(runningApplications));
        Method frontmost = class_getInstanceMethod([NSWorkspace class], @selector(frontmostApplication));
        IMP oldRunning = method_setImplementation(running, (IMP)runningApplications);
        IMP oldFrontmost = method_setImplementation(frontmost, (IMP)frontmostApplication);
        apps = @[record(123, @"Live app")];
        assert([snapshot(0)[@"applications"] count] == 1);
        apps = @[record(-1, @"Device Hub"), record(123, @"Live app"), record(0, @"Invalid")];
        NSDictionary *filtered = snapshot(0);
        assert([filtered[@"applications"] count] == 1);
        assert([filtered[@"applications"][0][@"pid"] intValue] == 123);
        apps = @[record(-1, nil)];
        assert([snapshot(0)[@"applications"] count] == 0);
        // A live record with invalid identity must still fail closed.
        apps = @[record(123, nil)];
        snapshot(2);
        apps = @[record(123, @"Duplicate"), record(123, @"Duplicate")];
        snapshot(2);
        method_setImplementation(running, oldRunning);
        method_setImplementation(frontmost, oldFrontmost);
        puts("PASS: invalid PIDs filtered; live identity and duplicate checks preserved");
    }
}
