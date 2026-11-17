# -*-coding:utf-8 -*-
# python 3.9
# 绘制deficit/surplus/balance

"""
# @File       : 8_MatchingMap.py
# @software   : PyCharm  
# @Time       ：2024/8/2 23:30
# @Author     ：Wei Lyu
"""

import pandas as pd
import matplotlib.pyplot as plt
import geopandas as gpd
from matplotlib.lines import Line2D
import numpy as np
import matplotlib.patches as mpatches

plt.rcParams['pdf.fonttype'] = 42

def drow_the_scale(ax, length_cm=2, lw=2):
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
    x_start = xlim[0] + 0.20 * x_range  # 将比例尺的 x 起点距离左边调整为 20%
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
    path = 'D:/LW/ABM/OutputData'

    sigma = 1

    relation = pd.read_csv(path + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    cities = ['上海市', '北京市', '深圳市', '重庆市', '广州市', '成都市', '天津市', '武汉市', '东莞市', '西安市', '杭州市', '佛山市', '南京市', '沈阳市',
              '青岛市', '济南市', '长沙市', '哈尔滨市', '郑州市', '大连市', '昆明市']
    positions = [cities_cn.index(element) for element in cities]

    cities_en = [cities_en[ind][:-3] for ind in positions]
    for i in range(len(cities_en)):
        if cities_en[i] == 'xian':
            cities_en[i] = 'xi\'an'
        if cities_en[i] == 'haerbin':
            cities_en[i] = 'harbin'

    color_map = {
        'balance': '#F2F5F9',
        'deficit': '#9F9FC5',
        'surplus': '#E089A0'
    }

    for i in range(len(cities)):
        city = cities[i]
        city_en = cities_en[i].capitalize()
        data_path = path + '/Result/cities_21_max/' + city + '/sigma=' + str(sigma)
        shp_path = path + '/cities_21/' + city + '/' + city + '_grid.shp'
        shp = gpd.read_file(shp_path)

        inflowPredShelter = pd.read_csv(data_path + '/inflowPredShelter_MatchLabel.csv', header=0)
        inflowPredShelter['Tid'] = inflowPredShelter['Tid'] - 1  # 推演的时候Tid比shp里的Tid大1
        merged = shp.merge(inflowPredShelter, on='Tid') # 合并 inflow DataFrame 和 shapefile
        boundary_shp = gpd.read_file(path + '/cities_21/' + city + '/' + city + '.shp')

        # 设置坐标系为 WGS84 (经纬度)
        merged = merged.to_crs(epsg=3857)
        boundary_shp = boundary_shp.to_crs(epsg=3857)

        merged['color'] = merged['match_type'].map(color_map)

        # 绘制地图，根据 'Match_type' 进行分类颜色
        plt.figure(figsize=(10, 6))
        ax = merged.plot(color=merged['color']) #, edgecolor='white', linewidth=0.5)

        # plt.xlabel('Longitude', fontsize=12)
        # plt.ylabel('Latitude', fontsize=12)
        boundary_shp.boundary.plot(ax=ax, edgecolor='k', linewidth=0.7)  # 绘制边界

        legend_elements = [
            Line2D([0], [0], marker='s', color='w', markerfacecolor=color_map['balance'], markersize=5, label='Balance'),
            Line2D([0], [0], marker='s', color='w', markerfacecolor=color_map['deficit'], markersize=5, label='Deficit'),
            Line2D([0], [0], marker='s', color='w', markerfacecolor=color_map['surplus'], markersize=5, label='Surplus')
        ]

        # 添加图例
        # ax.legend(handles=legend_elements, loc='best', handletextpad=0.2, fontsize=8)

        # 关闭ax边框
        for spine in ax.spines.values():
            spine.set_visible(False)

        # 添加经纬线
        # ax.grid(True, which='both', color='gray', linestyle='--', linewidth=0.5)
        # ax.set_axisbelow(True)
        # ax.tick_params(axis='both', length=0, width=0, labelsize=10)
        ax.tick_params(left=False, bottom=False, right=False, top=False)  # 关闭 X 和 Y 轴的所有刻度线

        # 隐藏 X 和 Y 轴的刻度标签
        ax.set_xticklabels([])
        ax.set_yticklabels([])

        drow_the_scale(ax, length_cm=0.02)

        plt.title(city_en, fontsize=16)
        plt.savefig(path + '/Result/pic/sigma=' + str(sigma) + '/Inflow/NumPerShelter/byMatchType/PNG/' + city_en + '.png', dpi=300)
        plt.savefig(path + '/Result/pic/sigma=' + str(sigma) + '/Inflow/NumPerShelter/byMatchType/PDF/' + city_en + '.pdf')
        # break
        plt.close()
