# -*-coding:utf-8 -*-
# python 3.9

"""
# @File       : 3_InlowHeatmap(zz&sz).py
# @software   : PyCharm  
# @Time       ：2024/7/20 15:35
# @Author     ：Wei Lyu
"""

import numpy as np
import matplotlib.cm as cm
import matplotlib.pyplot as plt
import pandas as pd
from scipy.stats import boxcox
import geopandas as gpd
from matplotlib import ticker
from matplotlib.colors import LogNorm, LinearSegmentedColormap
import matplotlib.colors as mcolors
from sklearn.preprocessing import MinMaxScaler
import contextily as ctx
import matplotlib.patches as mpatches

plt.rcParams['pdf.fonttype'] = 42

# 定义 Box-Cox 变换函数
def boxcox_transform(x, lmbda):
    # 将 NaN 替换为 1，以避免 boxcox 函数报错
    x_nonan = np.where(np.isnan(x), 1, x + 1e-6)
    transformed = boxcox(x_nonan, lmbda)
    # 将原始的 NaN 值还原
    return np.where(np.isnan(x), np.nan, transformed)

# 定义反向 Box-Cox 变换函数
def inv_boxcox_transform(x, lmbda):
    if lmbda == 0:
        return np.where(np.isnan(x), np.nan, np.exp(x))
    else:
        return np.where(np.isnan(x), np.nan, np.power((x * lmbda + 1), 1 / lmbda))

def drow_the_scale(ax, length_cm=2, lw=8):
    """
    画固定物理长度的比例尺，并根据投影坐标系计算实际距离（以整数公里显示）
    ax: Matplotlib 的 Axes 对象
    length_cm: 比例尺的物理长度，单位为厘米（默认 2 cm）
    lw: 比例尺线条的宽度
    """
    # 获取当前图形的分辨率和尺寸（单位：英寸）
    fig = ax.get_figure()
    dpi = fig.dpi  # 获取每英寸的点数
    length_inch = length_cm / 2.54  # 将厘米转换为英寸
    length_pixel = length_inch * dpi  # 将英寸转换为像素

    # 将像素长度转换为数据坐标系长度
    xlim = ax.get_xlim()
    ylim = ax.get_ylim()
    x_range = xlim[1] - xlim[0]  # x 轴数据范围
    bbox = ax.get_window_extent().transformed(fig.dpi_scale_trans.inverted())  # 获取轴的边界框，单位为英寸
    x_length_data = (length_pixel / bbox.width) * x_range  # 计算出比例尺在数据坐标系中的长度

    # 设置比例尺在图形中的位置
    x_start = xlim[0] + 0.03 * x_range  # 将比例尺的 x 起点距离左边调整为 3%
    y_pos = ylim[0] # + 0.02 * (ylim[1] - ylim[0])  # 调整 y 轴位置，距离底部 2%

    # 计算比例尺在 EPSG:3395 投影坐标系中的实际距离
    actual_distance_meters = x_length_data  # 投影坐标系的单位是米
    actual_distance_km = actual_distance_meters / 1000  # 转换为公里

    # 将实际距离四舍五入为最近的整数
    rounded_distance_km = np.round(actual_distance_km)

    # 调整图上比例尺的长度，使实际距离为整数公里
    scale_adjustment_factor = rounded_distance_km / actual_distance_km
    x_length_data_adjusted = x_length_data * scale_adjustment_factor  # 调整后的图上距离

    # 画比例尺
    ax.hlines(y=y_pos, xmin=x_start, xmax=x_start + x_length_data_adjusted, colors="black", lw=lw)

    # 在比例尺两端画刻度线
    ax.vlines(x=x_start, ymin=y_pos - lw / 200, ymax=y_pos + lw / 200, colors="black", lw=1)
    ax.vlines(x=x_start + x_length_data_adjusted, ymin=y_pos - lw / 200, ymax=y_pos + lw / 200, colors="black", lw=1)

    # 添加比例尺的实际整数距离
    ax.text(x_start + x_length_data_adjusted / 2, y_pos + lw / 100 * 40000, f'{int(rounded_distance_km)} km', ha='center', va='bottom',
            fontsize=10)


if __name__ == '__main__':
    path = 'D:/LW/ABM'
    outputPath = path + '/OutputData'

    sigma = 1
    lmbda = 0.3
    type = 'inflow'

    relation = pd.read_csv(outputPath + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    for i in range(len(cities_cn)):
        print(cities_cn[i])
        cities_en[i] = cities_en[i][:-3]
        if cities_en[i] == 'xian':
            cities_en[i] = 'xi\'an'
        if cities_en[i] == 'haerbin':
            cities_en[i] = 'harbin'
        city = cities_cn[i]
        basePath = outputPath + '/Result_SSP585/cities_21_max/' + city
        storagePath = outputPath + '/Result_SSP585/cities_21_max/' + city + '/sigma=' + str(sigma)
        pic_storagePath = basePath + '/pic/sigma=' + str(sigma)
        shp_path = outputPath + '/cities_21/' + city + '/' + city + '_grid.shp'
        shp = gpd.read_file(shp_path)
        boundary_shp = gpd.read_file(outputPath + '/cities_21/' + city + '/' + city + '.shp')

        inflow = pd.read_csv(storagePath + '/' + type + 'Pred.csv', header=0)
        inflow['Tid'] = inflow['Tid'] - 1  # 推演的时候Tid比shp里的Tid大1
        merged = shp.merge(inflow, on='Tid') # 合并 inflow DataFrame 和 shapefile

        # 归一化
        scaler = MinMaxScaler()
        merged['pred_'+type] = scaler.fit_transform(merged[['pred_'+type]])

        # 设置坐标系为 WGS84 (经纬度)
        merged = merged.to_crs(epsg=3857)

        
        colors = ['#44546A', '#8B518C', '#C85989', '#FFD166']
        cmap = LinearSegmentedColormap.from_list("custom_pink", colors, N=256)
        norm = mcolors.FuncNorm((lambda x: boxcox_transform(x, lmbda), lambda x: inv_boxcox_transform(x, lmbda)), vmin=0, vmax=1)

        merged['pred_'+type] = merged['pred_'+type].clip(lower=1e-5) 
        

        # 绘制地图
        fig, ax = plt.subplots(figsize=(10, 6))

        ax = merged.plot(column=merged['pred_'+type], ax=ax, norm=norm, cmap=cmap, edgecolor='none',
                    linewidth=0.001, legend=False) #, missing_kwds={'color': 'lightgrey'})
        # boundary_shp.plot(ax=ax, edgecolor='k', linewidth=1) # 绘制边界

        # ctx.add_basemap(ax, source='http://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png')  # 可选择不同的底图来源

        # plt.xlabel('Longitude', fontsize=16)
        # plt.ylabel('Latitude', fontsize=16)
        ax.set_title(cities_en[i].capitalize(), fontsize=18)

        ax1 = fig.add_axes([0.92, 0.25, 0.03, 0.5])
        # 隐藏 X 和 Y 轴的刻度标签
        ax.set_xticklabels([])
        ax.set_yticklabels([])

        # 关闭 X 和 Y 轴的所有刻度线
        ax.tick_params(left=False, bottom=False, right=False, top=False)

        # 关闭ax边框
        for spine in ax.spines.values():
            spine.set_visible(False)

        # colorbar设置
        cbar = fig.colorbar(cm.ScalarMappable(norm=norm, cmap=cmap), cax=ax1, orientation='vertical')
        cbar.ax.tick_params(labelsize=10)
        cbar.outline.set_visible(False)

        # 设置对数刻度的主刻度和次刻度，自动分配次刻度
        # cbar.ax.yaxis.set_major_locator(ticker.LogLocator(base=10.0, numticks=10))
        # cbar.ax.yaxis.set_minor_locator(ticker.LogLocator(base=10.0, subs=np.arange(2, 10), numticks=10))

        cbar.ax.set_title('Volume', fontsize=12)  # 设置颜色条标签
        # 添加经纬线
        # ax.grid(True, which='both', color='gray', linestyle='--', linewidth=0.5)
        # ax.set_axisbelow(True)
        # ax.tick_params(axis='both', length=0, width=0, labelsize=12)

        drow_the_scale(ax, length_cm=0.02)

        filename = 'pred' + type.capitalize() + 'Map_boxcox' + str(lmbda)

        plt.savefig(pic_storagePath + '/' + filename + '.pdf', format='pdf')
        plt.savefig(pic_storagePath + '/' + filename + '.png', dpi=300)
        plt.close()
        # break
